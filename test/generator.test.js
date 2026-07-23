import test from "node:test";
import assert from "node:assert/strict";
import {
  generateCandidateWithRetries,
  getMonday,
  validateMenu
} from "../src/scheduler/generator.js";
import { getCatchUpWeekStart } from "../src/scheduler/cron.js";
import { bearerTokenMatches } from "../src/auth/bearer.js";
import { parsePreferenceUpdate } from "../src/domain/preferences.js";
import { createRateLimiter } from "../src/security/rateLimit.js";

const dishes = [
  ["Whole Wheat Hakka Noodles", "carb_heavy"],
  ["Chicken Curry", "chicken_main"],
  ["Palak Paneer", "paneer_main"],
  ["Egg Curry", "sabzi"],
  ["Egg Bhurji", "sabzi"],
  ["Lemon Pepper Chicken", "dry_chicken"],
  ["Tandoori Chicken", "dry_chicken"],
  ["Cajun Chicken", "dry_chicken"]
].map(([name, category]) => ({ name, category, active: true }));

test("getMonday returns the next Monday for a Friday", () => {
  assert.equal(getMonday(0, new Date("2026-07-24T12:30:00Z")), "2026-07-27");
});

test("valid menu passes guardrail validation", () => {
  const menu = {
    week_start: "2026-07-27",
    days: [
      { day: "Monday", slot_type: "carb_heavy", main_dish: "Whole Wheat Hakka Noodles", side_chicken: "Lemon Pepper Chicken", prep_notes: "", cook_notes: "" },
      { day: "Tuesday", slot_type: "chicken_main", main_dish: "Chicken Curry", side_chicken: null, prep_notes: "Marinate Tandoori Chicken overnight for Thursday.", cook_notes: "" },
      { day: "Thursday", slot_type: "paneer_main", main_dish: "Palak Paneer", side_chicken: "Tandoori Chicken", prep_notes: "", cook_notes: "" },
      { day: "Friday", slot_type: "sabzi", main_dish: "Egg Curry", side_chicken: "Cajun Chicken", prep_notes: "", cook_notes: "" },
      { day: "Saturday", slot_type: "random", main_dish: "Egg Bhurji", side_chicken: "Lemon Pepper Chicken", prep_notes: "", cook_notes: "" }
    ]
  };
  assert.deepEqual(
    validateMenu(
      menu,
      dishes,
      {
        never_use: ["bhindi"],
        max_paneer_per_week: 1,
        max_carb_heavy_per_week: 1,
        cross_week_avoid_last_n_weeks: 3,
        custom_rules: []
      },
      "2026-07-27"
    ),
    []
  );
});

test("dry chicken sides may repeat, but not on consecutive scheduled days", () => {
  const menu = {
    week_start: "2026-07-27",
    days: [
      { day: "Monday", slot_type: "carb_heavy", main_dish: "Whole Wheat Hakka Noodles", side_chicken: "Lemon Pepper Chicken", prep_notes: "", cook_notes: "" },
      { day: "Tuesday", slot_type: "chicken_main", main_dish: "Chicken Curry", side_chicken: null, prep_notes: "Marinate Tandoori Chicken overnight for Thursday.", cook_notes: "" },
      { day: "Thursday", slot_type: "paneer_main", main_dish: "Palak Paneer", side_chicken: "Tandoori Chicken", prep_notes: "", cook_notes: "" },
      { day: "Friday", slot_type: "sabzi", main_dish: "Egg Curry", side_chicken: "Cajun Chicken", prep_notes: "", cook_notes: "" },
      { day: "Saturday", slot_type: "random", main_dish: "Egg Bhurji", side_chicken: "Cajun Chicken", prep_notes: "", cook_notes: "" }
    ]
  };
  const errors = validateMenu(
    menu,
    dishes,
    {
      never_use: ["bhindi"],
      max_paneer_per_week: 1,
      max_carb_heavy_per_week: 1,
      cross_week_avoid_last_n_weeks: 3,
      custom_rules: []
    },
    "2026-07-27"
  );
  assert.ok(errors.some((error) => /consecutive scheduled days/.test(error)));
  menu.days[4].side_chicken = "Lemon Pepper Chicken";
  assert.deepEqual(
    validateMenu(
      menu,
      dishes,
      {
        never_use: ["bhindi"],
        max_paneer_per_week: 1,
        max_carb_heavy_per_week: 1,
        cross_week_avoid_last_n_weeks: 3,
        custom_rules: []
      },
      "2026-07-27"
    ),
    []
  );
});

test("MCP bearer authentication accepts only an exact Bearer token", () => {
  assert.equal(bearerTokenMatches("Bearer correct-secret", "correct-secret"), true);
  assert.equal(bearerTokenMatches("bearer correct-secret", "correct-secret"), true);
  assert.equal(bearerTokenMatches("Bearer wrong-secret", "correct-secret"), false);
  assert.equal(bearerTokenMatches("Basic correct-secret", "correct-secret"), false);
  assert.equal(bearerTokenMatches(undefined, "correct-secret"), false);
});

test("preference updates reject unknown keys, wrong types, and free-form custom rules", () => {
  assert.throws(() => parsePreferenceUpdate("unknown", true));
  assert.throws(() => parsePreferenceUpdate("never_use", "bhindi"));
  assert.throws(() => parsePreferenceUpdate("custom_rules", ["eat something nice"]));
  assert.deepEqual(
    parsePreferenceUpdate("custom_rules", ["never:mushroom", "not_on:monday:Paneer Chilli"]),
    ["never:mushroom", "not_on:monday:Paneer Chilli"]
  );
});

test("generation retries a failed completion and returns a validated candidate", async () => {
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
  let calls = 0;
  const result = await generateCandidateWithRetries({
    prompt: "test",
    dishes,
    preferences: {
      never_use: ["bhindi"],
      max_paneer_per_week: 1,
      max_carb_heavy_per_week: 1,
      cross_week_avoid_last_n_weeks: 3,
      custom_rules: []
    },
    recentMenus: [],
    weekStart: "2026-07-27",
    completionFn: async () => {
      calls += 1;
      if (calls === 1) throw new SyntaxError("invalid JSON");
      return validMenu;
    }
  });
  assert.equal(calls, 2);
  assert.deepEqual(result, validMenu);
});

test("scheduler catch-up targets missed weeks without generating late-week menus", () => {
  assert.equal(
    getCatchUpWeekStart(new Date("2026-07-24T11:00:00Z"), "Asia/Kolkata"),
    null
  );
  assert.equal(
    getCatchUpWeekStart(new Date("2026-07-24T13:00:00Z"), "Asia/Kolkata"),
    "2026-07-27"
  );
  assert.equal(
    getCatchUpWeekStart(new Date("2026-07-27T04:00:00Z"), "Asia/Kolkata"),
    "2026-07-27"
  );
  assert.equal(
    getCatchUpWeekStart(new Date("2026-07-29T04:00:00Z"), "Asia/Kolkata"),
    null
  );
});

test("rate limiter rejects attempts beyond the configured window budget", () => {
  const limiter = createRateLimiter({ limit: 2, windowMs: 60_000 });
  assert.equal(limiter.consume("user").allowed, true);
  assert.equal(limiter.consume("user").allowed, true);
  assert.equal(limiter.consume("user").allowed, false);
  assert.equal(limiter.consume("other-user").allowed, true);
});
