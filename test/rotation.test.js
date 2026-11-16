import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  buildGenerationEligibility,
  getPreviousWeekMenu,
  previousWeekMainNames,
  validateMenu
} from "../src/domain/menu.js";

const dataDir = await mkdtemp(path.join(os.tmpdir(), "heisenberg-rotation-"));
process.env.DATA_DIR = dataDir;
const preferences = {
  never_use: ["bhindi"],
  max_paneer_per_week: 1,
  max_carb_heavy_per_week: 1,
  custom_rules: []
};
await writeFile(path.join(dataDir, "preferences.json"), JSON.stringify({
  preferences: { ...preferences, cross_week_avoid_last_n_weeks: 3 }
}));
const store = await import("../src/db/store.js");
const { generateMenu, MenuGenerationError } = await import("../src/scheduler/generator.js");
after(() => rm(dataDir, { recursive: true, force: true }));
await store.initStore();

const originalMains = ["Chicken Curry", "Whole Wheat Hakka Noodles", "Palak Paneer", "Egg Curry", "Egg Bhurji"];
const newMains = ["Chicken Chilli", "Pesto Spaghetti", "Paneer Sauté", "Aloo Gobi Capsicum Masala", "Cheela Chutney"];
const categories = ["chicken_main", "carb_heavy", "paneer_main", "sabzi", "sabzi"];
for (const mains of [originalMains, newMains]) {
  for (const [index, name] of mains.entries()) {
    await store.addDish({ name, category: categories[index] });
  }
}
for (const name of ["Lemon Pepper Chicken", "Tandoori Chicken", "Cajun Chicken"]) {
  await store.addDish({ name, category: "dry_chicken" });
}
const dishes = await store.getDishes();
function menu(weekStart, repeats = 5) {
  const weekdays = ["Monday", "Tuesday", "Thursday", "Friday", "Saturday"];
  const sides = [null, "Lemon Pepper Chicken", "Tandoori Chicken", "Cajun Chicken", "Lemon Pepper Chicken"];
  return {
    week_start: weekStart,
    days: weekdays.map((day, index) => ({
      day,
      slot_type: index === 4 ? "random" : categories[index],
      main_dish: index < repeats ? originalMains[index] : newMains[index],
      side_chicken: sides[index],
      prep_notes: index === 0 ? "Marinate Tandoori Chicken overnight for Thursday." : "",
      cook_notes: ""
    }))
  };
}
const previous = { ...menu("2026-08-24"), status: "active" };

test("existing installations retire the old three-week setting without losing preferences", async () => {
  assert.deepEqual(await store.getPreferences(), preferences);
  const persisted = JSON.parse(await readFile(path.join(dataDir, "preferences.json"), "utf8"));
  assert.deepEqual(persisted.preferences, preferences);
  await assert.rejects(store.updatePreference("cross_week_avoid_last_n_weeks", 3), /Unknown preference/);
});

test("weekly rotation allows zero through two repeated mains and rejects three through five", () => {
  for (let repeats = 0; repeats <= 5; repeats += 1) {
    const errors = validateMenu(menu("2026-08-31", repeats), dishes, preferences, "2026-08-31", [previous]);
    if (repeats <= 2) assert.deepEqual(errors, [], `allowed overlap: ${repeats}`);
    else assert.match(errors.join("; "), new RegExp(`${repeats} main dishes repeat.*at most 2`));
  }
});

test("moving dishes to other weekdays cannot bypass the repeat limit", () => {
  const shuffled = menu("2026-08-31");
  [shuffled.days[2].day, shuffled.days[3].day] = [shuffled.days[3].day, shuffled.days[2].day];
  assert.match(validateMenu(shuffled, dishes, preferences, "2026-08-31", [previous]).join("; "), /5 main dishes repeat/);
});

test("the cap applies even when there are no alternative dishes", () => {
  const smallPool = dishes.filter((dish) => !newMains.includes(dish.name));
  assert.match(validateMenu(menu("2026-08-31"), smallPool, preferences, "2026-08-31", [previous]).join("; "), /at most 2/);
});

test("older and future menus do not count, including when the previous week is missing", () => {
  const history = [
    { ...previous, week_start: "2026-08-17" },
    { ...previous, week_start: "2026-09-07" }
  ];
  assert.equal(getPreviousWeekMenu(history, "2026-08-31"), null);
  assert.deepEqual(validateMenu(menu("2026-08-31"), dishes, preferences, "2026-08-31", history), []);
});

test("accepted previous-week plans win over abandoned drafts and older confirmed revisions", () => {
  const active = { ...previous, generated_at: "2026-08-20T10:00:00Z" };
  const draft = { ...menu("2026-08-24", 0), status: "draft", generated_at: "2026-08-23T10:00:00Z" };
  const confirmed = { ...draft, status: "confirmed" };
  assert.deepEqual(getPreviousWeekMenu([draft, confirmed, active], "2026-08-31"), active);
  assert.deepEqual(getPreviousWeekMenu([active, confirmed, draft], "2026-08-31"), active);
  const olderDraft = { ...previous, status: "draft", generated_at: "2026-08-19T10:00:00Z" };
  assert.deepEqual(getPreviousWeekMenu([olderDraft, draft], "2026-08-31"), draft);
});

test("last-week lookup crosses year boundaries and ignores skipped days", () => {
  const history = [{
    ...previous,
    week_start: "2025-12-29",
    days: [
      { main_dish: "Chicken Curry", meal_status: "planned" },
      { main_dish: "Egg Curry", meal_status: "skipped" }
    ]
  }];
  assert.deepEqual([...previousWeekMainNames(history, "2026-01-05")], ["Chicken Curry"]);
});

test("eligibility allows both new and repeat options at the one-paneer and one-carb quotas", () => {
  const eligibility = buildGenerationEligibility({ dishes, preferences, recentMenus: [previous], weekStart: "2026-08-31" });
  assert.equal(eligibility.max_repeated_mains, 2);
  assert.deepEqual(eligibility.main_dishes_by_slot.paneer_main.preferred, ["Paneer Sauté"]);
  assert.deepEqual(eligibility.main_dishes_by_slot.paneer_main.repeat_candidates, ["Palak Paneer"]);
  assert.deepEqual(eligibility.main_dishes_by_slot.carb_heavy.preferred, ["Pesto Spaghetti"]);
  assert.deepEqual(eligibility.main_dishes_by_slot.carb_heavy.repeat_candidates, ["Whole Wheat Hakka Noodles"]);
  const candidate = menu("2026-08-31", 0);
  candidate.days[1].main_dish = originalMains[1];
  candidate.days[2].main_dish = originalMains[2];
  assert.deepEqual(validateMenu(candidate, dishes, preferences, "2026-08-31", [previous]), []);
});

test("explicit menu edits remain household overrides", () => {
  assert.deepEqual(validateMenu(menu("2026-08-31"), dishes, preferences, "2026-08-31", [previous], { mode: "edit" }), []);
});

test("weekly generation retries repeats, saves only a valid menu, and preserves history on failure", async () => {
  const old = await store.saveMenu(menu("2026-08-17"));
  await store.confirmMenu(old.id);
  const lastWeek = await store.saveMenu(menu("2026-08-24"));
  await store.confirmMenu(lastWeek.id);
  for (const date of ["2026-08-23", "2026-08-24", "2026-08-30", "2026-08-31"]) {
    await store.recordMeal({ date, scope: "household", main_dish: "Egg Curry" });
  }
  let calls = 0;
  const saved = await generateMenu({
    weekStart: "2026-08-31",
    scheduled: true,
    completionFn: async (prompt, correction) => {
      calls += 1;
      assert.match(prompt, /At most 2 distinct main dishes/);
      assert.ok(prompt.includes('"week_start":"2026-08-24"'));
      assert.ok(!prompt.includes('"week_start":"2026-08-17"'));
      assert.ok(prompt.includes('"date":"2026-08-24"'));
      assert.ok(prompt.includes('"date":"2026-08-30"'));
      assert.ok(!prompt.includes('"date":"2026-08-23"'));
      assert.ok(!prompt.includes('"date":"2026-08-31"'));
      assert.equal((await store.getMenus()).length, 2, "rejected candidates must not be saved");
      if (calls === 1) return menu("2026-08-31");
      assert.match(correction, /5 main dishes repeat.*at most 2/);
      return menu("2026-08-31", 2);
    }
  });
  assert.equal(calls, 2);
  assert.equal(saved.status, "draft");
  assert.equal((await store.getMenus()).length, 3);
  await store.confirmMenu(saved.id);
  const beforeFailure = await store.getMenus();
  calls = 0;
  await assert.rejects(generateMenu({
    weekStart: "2026-09-07",
    scheduled: true,
    completionFn: async () => {
      calls += 1;
      return menu("2026-09-07", 2);
    }
  }), MenuGenerationError);
  assert.equal(calls, 3);
  assert.deepEqual(await store.getMenus(), beforeFailure);
});
