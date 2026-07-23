import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const dataDir = await mkdtemp(path.join(os.tmpdir(), "heisenberg-store-"));
process.env.DATA_DIR = dataDir;
const store = await import("../src/db/store.js");

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
    /violates guardrails/
  );
  const afterMenu = await store.getLatestDraft();
  assert.equal(afterMenu.days[0].main_dish, before.days[0].main_dish);
});

test("confirmed upcoming menu remains available as relevant agent context", async () => {
  const draft = await store.getLatestDraft();
  const confirmed = await store.confirmMenu(draft.id);
  const relevant = await store.getRelevantMenu("2026-07-20");
  assert.equal(confirmed.status, "active");
  assert.equal(relevant.id, confirmed.id);
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
