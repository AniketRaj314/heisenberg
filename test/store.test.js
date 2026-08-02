import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const dataDir = await mkdtemp(path.join(os.tmpdir(), "heisenberg-store-"));
process.env.DATA_DIR = dataDir;
await writeFile(
  path.join(dataDir, "menus.json"),
  JSON.stringify({
    menus: [{
      id: "legacy-menu",
      week_start: "2020-01-06",
      generated_at: "2020-01-01T00:00:00.000Z",
      status: "confirmed",
      days: [{
        day: "Monday",
        slot_type: "sabzi",
        main_dish: "Egg Curry",
        side_chicken: null,
        prep_notes: "",
        cook_notes: ""
      }]
    }]
  })
);
const store = await import("../src/db/store.js");
const { executeTool } = await import("../src/mcp/tools.js");

after(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

await store.initStore();

const dishInputs = [
  ["Whole Wheat Hakka Noodles", "carb_heavy"],
  ["Chicken Curry", "chicken_main"],
  ["Palak Paneer", "paneer_main"],
  ["Egg Curry", "sabzi"],
  ["Egg Bhurji", "sabzi"],
  ["Lemon Pepper Chicken", "dry_chicken"],
  ["Tandoori Chicken", "dry_chicken"],
  ["Cajun Chicken", "dry_chicken"]
];
for (const [name, category] of dishInputs) {
  await store.addDish({ name, category });
}

test("legacy menus migrate to the flexible schema without losing meals", async () => {
  const legacy = (await store.getMenus()).find((menu) => menu.id === "legacy-menu");
  assert.equal(legacy.schema_version, 2);
  assert.deepEqual(legacy.changes, []);
  assert.equal(legacy.days[0].meal_status, "planned");
  assert.equal(legacy.days[0].main_dish, "Egg Curry");
});

const validMenu = {
  week_start: "2026-07-27",
  days: [
    { day: "Monday", slot_type: "carb_heavy", main_dish: "Whole Wheat Hakka Noodles", side_chicken: "Lemon Pepper Chicken", prep_notes: "", cook_notes: "" },
    { day: "Tuesday", slot_type: "chicken_main", main_dish: "Chicken Curry", side_chicken: null, prep_notes: "Marinate Tandoori Chicken overnight for Thursday.", cook_notes: "" },
    { day: "Thursday", slot_type: "paneer_main", main_dish: "Palak Paneer", side_chicken: "Tandoori Chicken", prep_notes: "", cook_notes: "" },
    { day: "Friday", slot_type: "sabzi", main_dish: "Egg Curry", side_chicken: "Cajun Chicken", prep_notes: "", cook_notes: "" },
    { day: "Saturday", slot_type: "random", main_dish: "Egg Bhurji", side_chicken: "Lemon Pepper Chicken", prep_notes: "", cook_notes: "" }
  ]
};

test("saved menu metadata is server-controlled", async () => {
  await assert.rejects(
    store.saveMenu({ ...validMenu, status: "active" }),
    /Unrecognized key/
  );
  const saved = await store.saveMenu(validMenu);
  assert.equal(saved.status, "draft");
  assert.match(saved.id, /^[0-9a-f-]{36}$/);
  assert.ok(saved.generated_at);
});

test("invalid menu changes are rejected without mutating stored data", async () => {
  const before = await store.getLatestDraft();
  await assert.rejects(
    store.modifyMenuDay({
      menuId: before.id,
      day: "Monday",
      main_dish: "Unknown Dish"
    }),
    /Inactive or unknown main dish/
  );
  const afterMenu = await store.getLatestDraft();
  assert.equal(afterMenu.days[0].main_dish, before.days[0].main_dish);
});

test("menu changes require a concrete mutation", async () => {
  const before = await store.getLatestDraft();
  await assert.rejects(
    store.modifyMenuDay({ menuId: before.id, day: "Saturday" }),
    /at least one menu field/
  );
  const after = await store.getLatestDraft();
  assert.deepEqual(after.days, before.days);
});

test("editing notes does not rewrite a generated random slot", async () => {
  const menu = await store.getLatestDraft();
  const otherDays = menu.days
    .filter((entry) => entry.day !== "Saturday")
    .map((entry) => structuredClone(entry));
  const changed = await store.modifyMenuDay({
    menuId: menu.id,
    day: "Saturday",
    cook_notes: "Keep it quick"
  });
  const saturday = changed.days.find((entry) => entry.day === "Saturday");
  assert.equal(saturday.slot_type, "random");
  assert.equal(saturday.main_dish, "Egg Bhurji");
  assert.deepEqual(
    changed.days.filter((entry) => entry.day !== "Saturday"),
    otherDays
  );
});

test("explicit menu edits can override generation policy and return a receipt", async () => {
  const before = await store.getLatestDraft();
  const changed = await store.modifyMenuDay({
    menuId: before.id,
    day: "Saturday",
    main_dish: "Chicken Curry"
  });
  const saturday = changed.days.find((entry) => entry.day === "Saturday");

  assert.equal(saturday.main_dish, "Chicken Curry");
  assert.equal(saturday.slot_type, "chicken_main");
  assert.equal(saturday.side_chicken, null);
  assert.match(changed.action.summary, /Egg Bhurji → Chicken Curry/);
  assert.match(changed.action.summary, /Lemon Pepper Chicken → none/);

  await assert.rejects(
    store.modifyMenuDay({
      menuId: before.id,
      day: "Saturday",
      main_dish: "Chicken Curry"
    }),
    /No change was made/
  );

  await assert.rejects(
    store.modifyMenuDay({
      menuId: before.id,
      day: "Friday",
      side_chicken: "Chicken Curry"
    }),
    /invalid side chicken/
  );
});

test("marking a planned day unavailable does not relocate its meal", async () => {
  const before = await store.getLatestDraft();
  const unchangedDays = before.days
    .filter((entry) => entry.day !== "Saturday")
    .map((entry) => structuredClone(entry));
  const changed = await store.modifyMenuDay({
    menuId: before.id,
    day: "Saturday",
    meal_status: "dining_out",
    cook_notes: "Hackathon"
  }, { source: "test", requestId: "saturday-dining-out" });

  const saturday = changed.days.find((entry) => entry.day === "Saturday");
  assert.equal(saturday.meal_status, "dining_out");
  assert.equal(saturday.main_dish, null);
  assert.deepEqual(
    changed.days.filter((entry) => entry.day !== "Saturday"),
    unchangedDays
  );
});

test("any weekday can be unavailable, planned later, or unscheduled idempotently", async () => {
  const menu = await store.getLatestDraft();
  const context = {
    source: "test",
    requestId: "add-sunday-once",
    actor: { telegram_user_id: "202", display_name: "Rushil" }
  };
  const diningOut = await store.modifyMenuDay({
    menuId: menu.id,
    day: "Sunday",
    meal_status: "dining_out",
    cook_notes: "Dinner with family"
  }, context);
  const sundayOut = diningOut.days.find((entry) => entry.day === "Sunday");
  assert.equal(sundayOut.meal_status, "dining_out");
  assert.equal(sundayOut.main_dish, null);
  assert.match(diningOut.action.summary, /Marked Sunday as dining out/);
  assert.equal(diningOut.action.actor.telegram_user_id, "202");

  const repeated = await store.modifyMenuDay({
    menuId: menu.id,
    day: "Sunday",
    meal_status: "dining_out",
    cook_notes: "Dinner with family"
  }, context);
  assert.equal(repeated.action.id, diningOut.action.id);
  assert.equal(repeated.changes.length, diningOut.changes.length);

  const planned = await store.modifyMenuDay({
    menuId: menu.id,
    day: "Sunday",
    meal_status: "planned",
    main_dish: "Egg Curry",
    side_chicken: "Cajun Chicken"
  }, { source: "test", requestId: "plan-sunday" });
  const sundayPlanned = planned.days.find((entry) => entry.day === "Sunday");
  assert.equal(sundayPlanned.meal_status, "planned");
  assert.equal(sundayPlanned.slot_type, "sabzi");
  assert.equal(sundayPlanned.main_dish, "Egg Curry");

  const unscheduled = await store.modifyMenuDay({
    menuId: menu.id,
    day: "Sunday",
    meal_status: "unscheduled"
  }, { source: "test", requestId: "remove-sunday" });
  assert.ok(!unscheduled.days.some((entry) => entry.day === "Sunday"));
  assert.equal(unscheduled.action.summary, "Unscheduled Sunday.");
});

test("confirmed upcoming menu remains available as relevant agent context", async () => {
  const draft = await store.getLatestDraft();
  const confirmed = await store.confirmMenu(draft.id);
  const relevant = await store.getRelevantMenu("2026-07-20");
  assert.equal(confirmed.status, "active");
  assert.equal(relevant.id, confirmed.id);
});

test("complete meals can be swapped between scheduled weekdays", async () => {
  const menu = await store.getRelevantMenu("2026-07-20");
  const swapped = await store.swapMenuDays({
    menuId: menu.id,
    firstDay: "Tuesday",
    secondDay: "Thursday"
  });
  const tuesday = swapped.days.find((entry) => entry.day === "Tuesday");
  const thursday = swapped.days.find((entry) => entry.day === "Thursday");

  assert.equal(tuesday.slot_type, "paneer_main");
  assert.equal(tuesday.main_dish, "Palak Paneer");
  assert.equal(tuesday.side_chicken, "Tandoori Chicken");
  assert.match(tuesday.prep_notes, /overnight before Tuesday/);
  assert.equal(thursday.slot_type, "chicken_main");
  assert.equal(thursday.main_dish, "Chicken Curry");
  assert.equal(thursday.side_chicken, null);
  assert.doesNotMatch(thursday.prep_notes, /Tandoori/);
});

test("a complete meal can move to an unscheduled weekday", async () => {
  const menu = await store.getRelevantMenu("2026-07-20");
  const moved = await store.moveMenuDay({
    menuId: menu.id,
    fromDay: "Tuesday",
    toDay: "Wednesday"
  });
  assert.ok(!moved.days.some((entry) => entry.day === "Tuesday"));
  const wednesday = moved.days.find((entry) => entry.day === "Wednesday");
  assert.equal(wednesday.main_dish, "Palak Paneer");
  assert.equal(wednesday.side_chicken, "Tandoori Chicken");
  assert.match(wednesday.prep_notes, /overnight before Wednesday/);

  await assert.rejects(
    store.moveMenuDay({
      menuId: moved.id,
      fromDay: "Wednesday",
      toDay: "Thursday"
    }),
    /already scheduled/
  );
});

test("preference writes are schema validated", async () => {
  await assert.rejects(store.updatePreference("never_use", "bhindi"));
  await assert.rejects(store.updatePreference("made_up_key", true));
  const updated = await store.updatePreference("never_use", ["bhindi", "mushroom"]);
  assert.deepEqual(updated.never_use, ["bhindi", "mushroom"]);
});

test("concurrent dish writes are serialized", async () => {
  await Promise.all(
    Array.from({ length: 20 }, (_, index) =>
      store.addDish({ name: `Concurrent Dish ${index}`, category: "sabzi" })
    )
  );
  const dishes = await store.getDishes();
  assert.equal(
    dishes.filter((dish) => dish.name.startsWith("Concurrent Dish ")).length,
    20
  );
});

test("dishes can be renamed, recategorised, retagged, and enabled or disabled", async () => {
  const updated = await store.updateDish({
    name_or_id: "Palak Paneer",
    name: "Palak Paneer Light",
    category: "sabzi",
    tags: ["high-protein", "high-protein"],
    active: false
  });
  assert.equal(updated.name, "Palak Paneer Light");
  assert.equal(updated.category, "sabzi");
  assert.deepEqual(updated.tags, ["high-protein"]);
  assert.equal(updated.active, false);

  const enabled = await store.updateDish({
    name_or_id: updated.id,
    active: true
  });
  assert.equal(enabled.active, true);
});

test("dish updates reject duplicate names and empty changes", async () => {
  await assert.rejects(
    store.updateDish({ name_or_id: "Egg Curry", name: "Egg Bhurji" }),
    /already exists/
  );
  await assert.rejects(
    store.updateDish({ name_or_id: "Egg Curry" }),
    /At least one dish field/
  );
});

test("conversation history preserves Telegram sender identity", async () => {
  await store.saveConversation(
    "What is for dinner?",
    "Chicken Curry.",
    {
      telegram_user_id: "202",
      display_name: "Rahul",
      username: "rahul"
    }
  );
  const history = await store.getConversationHistory(1);
  assert.equal(history[0].sender.telegram_user_id, "202");
  assert.equal(history[0].sender.display_name, "Rahul");
});

test("actual meal history supports partial facts, corrections, and scopes", async () => {
  const sideOnly = await store.recordMeal({
    date: "2026-07-23",
    scope: "household",
    side_chicken: "Lemon Pepper Chicken",
    source: "test",
    recordedBy: "202"
  });
  assert.equal(sideOnly.main_dish, null);
  assert.equal(sideOnly.side_chicken, "Lemon Pepper Chicken");

  const completed = await store.recordMeal({
    date: "2026-07-23",
    scope: "household",
    main_dish: "Egg Bhurji",
    source: "test",
    recordedBy: "101"
  });
  assert.equal(completed.id, sideOnly.id);
  assert.equal(completed.main_dish, "Egg Bhurji");
  assert.equal(completed.side_chicken, "Lemon Pepper Chicken");

  const personal = await store.recordMeal({
    date: "2026-07-23",
    scope: "person:101",
    main_dish: "Pesto Spaghetti",
    source: "test",
    recordedBy: "101"
  });
  assert.notEqual(personal.id, completed.id);

  const householdOnly = await store.getMealHistory({
    scopes: ["household"],
    limit: 10
  });
  assert.deepEqual(householdOnly.map((meal) => meal.id), [completed.id]);

  const visibleToAniket = await store.getMealHistory({
    scopes: ["household", "person:101"],
    limit: 10
  });
  assert.equal(visibleToAniket.length, 2);

  await assert.rejects(
    store.forgetMeal(personal.id, ["household"]),
    /not found in an accessible scope/
  );
  const removed = await store.forgetMeal(personal.id, [
    "household",
    "person:101"
  ]);
  assert.equal(removed.id, personal.id);
});

test("meal tools bind personal history to the current Telegram sender", async () => {
  const actor = {
    telegram_user_id: "505",
    display_name: "Person 505",
    username: null
  };
  const saved = await executeTool(
    "record_meal",
    {
      date: "2026-07-22",
      scope: "personal",
      main_dish: "Chicken Curry"
    },
    { actor, source: "test" }
  );
  assert.equal(saved.scope, "person:505");

  const visible = await executeTool(
    "get_meal_history",
    { scope: "personal", limit: 10 },
    { actor, source: "test" }
  );
  assert.ok(visible.some((meal) => meal.id === saved.id));
});

test("durable memories are deduplicated, searchable, and scope-isolated", async () => {
  const household = await store.rememberContext({
    scope: "household",
    content: "Friday dinners should be quick."
  });
  const aniket = await store.rememberContext({
    scope: "person:101",
    content: "Prefers Sprite Zero with noodles."
  });
  const duplicate = await store.rememberContext({
    scope: "person:101",
    content: "Prefers Sprite Zero with noodles."
  });
  const brother = await store.rememberContext({
    scope: "person:202",
    content: "Prefers extra spicy chicken."
  });
  assert.equal(duplicate.id, aniket.id);

  const visibleToAniket = await store.searchContext({
    scopes: ["household", "person:101"],
    query: "Friday Sprite",
    limit: 10
  });
  assert.ok(visibleToAniket.some((memory) => memory.id === household.id));
  assert.ok(visibleToAniket.some((memory) => memory.id === aniket.id));
  assert.ok(!visibleToAniket.some((memory) => memory.id === brother.id));

  await assert.rejects(
    store.forgetContext(brother.id, ["household", "person:101"]),
    /not found in an accessible scope/
  );
  const removed = await store.forgetContext(aniket.id, [
    "household",
    "person:101"
  ]);
  assert.equal(removed.id, aniket.id);
});

test("memory tools bind personal scope to the current Telegram sender", async () => {
  const sender303 = {
    telegram_user_id: "303",
    display_name: "Person 303",
    username: null
  };
  const sender404 = {
    telegram_user_id: "404",
    display_name: "Person 404",
    username: null
  };
  const saved = await executeTool(
    "remember_context",
    { scope: "personal", content: "Only person 303 likes this condiment." },
    { actor: sender303, source: "test" }
  );
  const ownResults = await executeTool(
    "search_context",
    { scope: "all", query: "condiment", limit: 20 },
    { actor: sender303, source: "test" }
  );
  const otherResults = await executeTool(
    "search_context",
    { scope: "all", query: "condiment", limit: 20 },
    { actor: sender404, source: "test" }
  );
  assert.ok(ownResults.some((memory) => memory.id === saved.id));
  assert.ok(!otherResults.some((memory) => memory.id === saved.id));
});
