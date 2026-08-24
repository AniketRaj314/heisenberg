import test from "node:test";
import assert from "node:assert/strict";
import {
  formatMenuGenerationFailure,
  generateCandidateWithRetries,
  getMonday,
  MenuGenerationError,
  validateRegenerationDiversity,
  validateMenu
} from "../src/scheduler/generator.js";
import {
  buildGenerationEligibility,
  protectedMainNames
} from "../src/domain/menu.js";
import { getCatchUpWeekStart } from "../src/scheduler/cron.js";
import { bearerTokenMatches } from "../src/auth/bearer.js";
import { parsePreferenceUpdate } from "../src/domain/preferences.js";
import { createRateLimiter } from "../src/security/rateLimit.js";
import { localDateISO } from "../src/time.js";
import { buildMenuGenerationPrompt } from "../src/prompts/menu_generation.js";

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

test("local date resolution respects the configured household timezone", () => {
  const instant = new Date("2026-07-23T20:00:00Z");
  assert.equal(localDateISO(instant, "UTC"), "2026-07-23");
  assert.equal(localDateISO(instant, "Asia/Kolkata"), "2026-07-24");
});

test("valid menu passes guardrail validation", () => {
  const menu = {
    week_start: "2026-07-27",
    days: [
      { day: "Monday", slot_type: "chicken_main", main_dish: "Chicken Curry", side_chicken: null, prep_notes: "Marinate Tandoori Chicken overnight for Thursday.", cook_notes: "" },
      { day: "Tuesday", slot_type: "carb_heavy", main_dish: "Whole Wheat Hakka Noodles", side_chicken: "Lemon Pepper Chicken", prep_notes: "", cook_notes: "" },
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

test("generation schedules carb-heavy food after Monday", () => {
  const menu = {
    week_start: "2026-07-27",
    days: [
      { day: "Monday", slot_type: "carb_heavy", main_dish: "Whole Wheat Hakka Noodles", side_chicken: "Lemon Pepper Chicken", prep_notes: "", cook_notes: "" },
      { day: "Tuesday", slot_type: "chicken_main", main_dish: "Chicken Curry", side_chicken: null, prep_notes: "", cook_notes: "" },
      { day: "Thursday", slot_type: "paneer_main", main_dish: "Palak Paneer", side_chicken: "Tandoori Chicken", prep_notes: "Marinate Tandoori Chicken overnight before Thursday.", cook_notes: "" },
      { day: "Friday", slot_type: "sabzi", main_dish: "Egg Curry", side_chicken: "Cajun Chicken", prep_notes: "", cook_notes: "" },
      { day: "Saturday", slot_type: "random", main_dish: "Egg Bhurji", side_chicken: "Lemon Pepper Chicken", prep_notes: "", cook_notes: "" }
    ]
  };
  assert.ok(
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
    ).some((error) => /carb-heavy slot cannot be scheduled on Monday/.test(error))
  );
});

test("rotation history ignores drafts and includes actual meals", () => {
  const protectedNames = protectedMainNames({
    recentMenus: [
      {
        week_start: "2026-08-17",
        status: "draft",
        days: [{ main_dish: "Chicken Curry" }]
      },
      {
        week_start: "2026-08-10",
        status: "active",
        days: [{ main_dish: "Egg Curry" }]
      }
    ],
    recentMeals: [
      { date: "2026-08-22", main_dish: "Paneer Sauté" },
      { date: "2026-07-01", main_dish: "Old Dinner" }
    ],
    weeks: 3,
    weekStart: "2026-08-31"
  });

  assert.equal(protectedNames.has("Chicken Curry"), false);
  assert.equal(protectedNames.has("Egg Curry"), true);
  assert.equal(protectedNames.has("Paneer Sauté"), true);
  assert.equal(protectedNames.has("Old Dinner"), false);
});

test("actual meals enforce rotation while abandoned drafts do not", () => {
  const expandedDishes = [
    ...dishes,
    { name: "Chicken Chilli", category: "chicken_main", active: true }
  ];
  const menu = {
    week_start: "2026-08-31",
    days: [
      { day: "Monday", slot_type: "chicken_main", main_dish: "Chicken Curry", side_chicken: null, prep_notes: "", cook_notes: "" },
      { day: "Tuesday", slot_type: "carb_heavy", main_dish: "Whole Wheat Hakka Noodles", side_chicken: "Lemon Pepper Chicken", prep_notes: "", cook_notes: "" },
      { day: "Thursday", slot_type: "paneer_main", main_dish: "Palak Paneer", side_chicken: "Tandoori Chicken", prep_notes: "Marinate Tandoori Chicken overnight before Thursday.", cook_notes: "" },
      { day: "Friday", slot_type: "sabzi", main_dish: "Egg Curry", side_chicken: "Cajun Chicken", prep_notes: "", cook_notes: "" },
      { day: "Saturday", slot_type: "random", main_dish: "Egg Bhurji", side_chicken: "Lemon Pepper Chicken", prep_notes: "", cook_notes: "" }
    ]
  };
  const preferences = {
    never_use: ["bhindi"],
    max_paneer_per_week: 1,
    max_carb_heavy_per_week: 1,
    cross_week_avoid_last_n_weeks: 3,
    custom_rules: []
  };
  const abandonedDraft = {
    week_start: "2026-08-17",
    status: "draft",
    days: [{ main_dish: "Chicken Curry" }]
  };

  assert.deepEqual(
    validateMenu(menu, expandedDishes, preferences, "2026-08-31", [abandonedDraft]),
    []
  );
  assert.ok(
    validateMenu(
      menu,
      expandedDishes,
      preferences,
      "2026-08-31",
      [abandonedDraft],
      { recentMeals: [{ date: "2026-08-23", main_dish: "Chicken Curry" }] }
    ).some((error) => /Chicken Curry repeats within the protected history/.test(error))
  );
});

test("generation eligibility exposes exact preferred and fallback dishes", () => {
  const expandedDishes = [
    ...dishes,
    { name: "Chicken Chilli", category: "chicken_main", active: true },
    { name: "Pesto Spaghetti", category: "carb_heavy", active: true }
  ];
  const eligibility = buildGenerationEligibility({
    dishes: expandedDishes,
    preferences: {
      never_use: ["bhindi"],
      max_paneer_per_week: 1,
      max_carb_heavy_per_week: 1,
      cross_week_avoid_last_n_weeks: 3,
      custom_rules: []
    },
    recentMenus: [
      {
        week_start: "2026-08-17",
        status: "active",
        days: [{ main_dish: "Chicken Curry" }]
      }
    ],
    weekStart: "2026-08-31"
  });

  assert.deepEqual(
    eligibility.main_dishes_by_slot.chicken_main.preferred,
    ["Chicken Chilli"]
  );
  assert.deepEqual(
    eligibility.main_dishes_by_slot.chicken_main.history_fallback,
    []
  );
  assert.equal(
    eligibility.main_dishes_by_slot.random.preferred.includes("Pesto Spaghetti"),
    false
  );
  assert.equal(eligibility.slot_day_constraints.carb_heavy.includes("Monday"), false);
});

test("dry chicken sides may repeat, but not on consecutive scheduled days", () => {
  const menu = {
    week_start: "2026-07-27",
    days: [
      { day: "Monday", slot_type: "chicken_main", main_dish: "Chicken Curry", side_chicken: null, prep_notes: "Marinate Tandoori Chicken overnight for Thursday.", cook_notes: "" },
      { day: "Tuesday", slot_type: "carb_heavy", main_dish: "Whole Wheat Hakka Noodles", side_chicken: "Lemon Pepper Chicken", prep_notes: "", cook_notes: "" },
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

test("generation uses every eligible dry chicken side before repeating one", () => {
  const dishesWithExtraSide = [
    ...dishes,
    {
      name: "Garlic Herb Chicken",
      category: "dry_chicken",
      active: true,
      tags: []
    }
  ];
  const menu = {
    week_start: "2026-07-27",
    days: [
      { day: "Monday", slot_type: "carb_heavy", main_dish: "Whole Wheat Hakka Noodles", side_chicken: "Lemon Pepper Chicken", prep_notes: "", cook_notes: "" },
      { day: "Tuesday", slot_type: "chicken_main", main_dish: "Chicken Curry", side_chicken: null, prep_notes: "", cook_notes: "" },
      { day: "Thursday", slot_type: "paneer_main", main_dish: "Palak Paneer", side_chicken: "Tandoori Chicken", prep_notes: "Marinate Tandoori Chicken overnight before Thursday.", cook_notes: "" },
      { day: "Friday", slot_type: "sabzi", main_dish: "Egg Curry", side_chicken: "Cajun Chicken", prep_notes: "", cook_notes: "" },
      { day: "Saturday", slot_type: "random", main_dish: "Egg Bhurji", side_chicken: "Lemon Pepper Chicken", prep_notes: "", cook_notes: "" }
    ]
  };
  const errors = validateMenu(
    menu,
    dishesWithExtraSide,
    {
      never_use: ["bhindi"],
      max_paneer_per_week: 1,
      max_carb_heavy_per_week: 1,
      cross_week_avoid_last_n_weeks: 3,
      custom_rules: []
    },
    "2026-07-27"
  );
  assert.ok(errors.some((error) => /repeats before eligible sides are used/.test(error)));
});

test("generated menus still require the default weekdays", () => {
  const menu = {
    week_start: "2026-07-27",
    days: [
      { day: "Monday", slot_type: "carb_heavy", main_dish: "Whole Wheat Hakka Noodles", side_chicken: "Lemon Pepper Chicken", prep_notes: "", cook_notes: "" },
      { day: "Tuesday", slot_type: "chicken_main", main_dish: "Chicken Curry", side_chicken: null, prep_notes: "", cook_notes: "" },
      { day: "Wednesday", slot_type: "paneer_main", main_dish: "Palak Paneer", side_chicken: "Tandoori Chicken", prep_notes: "Marinate Tandoori Chicken overnight before Wednesday.", cook_notes: "" },
      { day: "Friday", slot_type: "sabzi", main_dish: "Egg Curry", side_chicken: "Cajun Chicken", prep_notes: "", cook_notes: "" },
      { day: "Saturday", slot_type: "random", main_dish: "Egg Bhurji", side_chicken: "Lemon Pepper Chicken", prep_notes: "", cook_notes: "" }
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
  assert.ok(errors.some((error) => /required weekdays/.test(error)));
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

test("automatic generation receives free-form household planning context", () => {
  const prompt = buildMenuGenerationPrompt({
    weekStart: "2026-08-03",
    dishes: [],
    preferences: {
      never_use: [],
      max_paneer_per_week: 1,
      max_carb_heavy_per_week: 1,
      cross_week_avoid_last_n_weeks: 3,
      custom_rules: []
    },
    recentMenus: [],
    householdContext: [{ content: "Prefer easy induction-friendly dinners" }],
    eligibility: {
      main_dishes_by_slot: {
        sabzi: { preferred: ["Egg Bhurji"], history_fallback: [] }
      }
    }
  });
  assert.match(prompt, /HOUSEHOLD PLANNING CONTEXT/);
  assert.match(prompt, /easy induction-friendly dinners/);
  assert.match(prompt, /soft guidance/);
  assert.match(prompt, /SERVER-COMPUTED ELIGIBILITY/);
  assert.match(prompt, /Egg Bhurji/);
  assert.match(prompt, /carb_heavy slot must not be scheduled on Monday/);
});

test("generation retries a failed completion and returns a validated candidate", async () => {
  const validMenu = {
    week_start: "2026-07-27",
    days: [
      { day: "Monday", slot_type: "chicken_main", main_dish: "Chicken Curry", side_chicken: null, prep_notes: "Marinate Tandoori Chicken overnight for Thursday.", cook_notes: "" },
      { day: "Tuesday", slot_type: "carb_heavy", main_dish: "Whole Wheat Hakka Noodles", side_chicken: "Lemon Pepper Chicken", prep_notes: "", cook_notes: "" },
      { day: "Thursday", slot_type: "paneer_main", main_dish: "Palak Paneer", side_chicken: "Tandoori Chicken", prep_notes: "", cook_notes: "" },
      { day: "Friday", slot_type: "sabzi", main_dish: "Egg Curry", side_chicken: "Cajun Chicken", prep_notes: "", cook_notes: "" },
      { day: "Saturday", slot_type: "random", main_dish: "Egg Bhurji", side_chicken: "Lemon Pepper Chicken", prep_notes: "", cook_notes: "" }
    ]
  };
  let calls = 0;
  let retryCorrection = "";
  const eligibility = { main_dishes_by_slot: { chicken_main: { preferred: ["Chicken Curry"] } } };
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
    eligibility,
    completionFn: async (_prompt, correction) => {
      calls += 1;
      if (calls === 1) throw new SyntaxError("invalid JSON");
      retryCorrection = correction;
      return validMenu;
    }
  });
  assert.equal(calls, 2);
  assert.deepEqual(result, validMenu);
  assert.match(retryCorrection, /exact server-computed eligible choices/);
  assert.match(retryCorrection, /Chicken Curry/);
});

test("generation failures produce an actionable Telegram message", () => {
  const message = formatMenuGenerationFailure(
    new MenuGenerationError(["Egg Curry repeats while alternatives remain"], 3)
  );
  assert.match(message, /nothing was saved/i);
  assert.match(message, /Egg Curry repeats/);
  assert.match(message, /dish rotation/i);
});

test("regeneration rejects a near-duplicate draft when alternatives exist", async () => {
  const expandedDishes = [
    ...dishes,
    ["Pesto Spaghetti", "carb_heavy"],
    ["Chicken Chilli", "chicken_main"],
    ["Paneer Sauté", "paneer_main"],
    ["Aloo Gobi Capsicum Masala", "sabzi"]
  ].map((dish) =>
    Array.isArray(dish)
      ? { name: dish[0], category: dish[1], active: true }
      : dish
  );
  const previousDraft = {
    week_start: "2026-07-27",
    days: [
      { day: "Monday", slot_type: "chicken_main", main_dish: "Chicken Curry", side_chicken: null, prep_notes: "Marinate Tandoori Chicken overnight for Thursday.", cook_notes: "" },
      { day: "Tuesday", slot_type: "carb_heavy", main_dish: "Whole Wheat Hakka Noodles", side_chicken: "Lemon Pepper Chicken", prep_notes: "", cook_notes: "" },
      { day: "Thursday", slot_type: "paneer_main", main_dish: "Palak Paneer", side_chicken: "Tandoori Chicken", prep_notes: "", cook_notes: "" },
      { day: "Friday", slot_type: "sabzi", main_dish: "Egg Curry", side_chicken: "Cajun Chicken", prep_notes: "", cook_notes: "" },
      { day: "Saturday", slot_type: "random", main_dish: "Egg Bhurji", side_chicken: "Lemon Pepper Chicken", prep_notes: "", cook_notes: "" }
    ]
  };
  const replacement = {
    week_start: "2026-07-27",
    days: [
      { day: "Monday", slot_type: "chicken_main", main_dish: "Chicken Chilli", side_chicken: null, prep_notes: "Marinate Tandoori Chicken overnight for Thursday.", cook_notes: "" },
      { day: "Tuesday", slot_type: "carb_heavy", main_dish: "Pesto Spaghetti", side_chicken: "Lemon Pepper Chicken", prep_notes: "", cook_notes: "" },
      { day: "Thursday", slot_type: "paneer_main", main_dish: "Paneer Sauté", side_chicken: "Tandoori Chicken", prep_notes: "", cook_notes: "" },
      { day: "Friday", slot_type: "sabzi", main_dish: "Aloo Gobi Capsicum Masala", side_chicken: "Cajun Chicken", prep_notes: "", cook_notes: "" },
      { day: "Saturday", slot_type: "random", main_dish: "Egg Curry", side_chicken: "Lemon Pepper Chicken", prep_notes: "", cook_notes: "" }
    ]
  };
  const preferences = {
    never_use: ["bhindi"],
    max_paneer_per_week: 1,
    max_carb_heavy_per_week: 1,
    cross_week_avoid_last_n_weeks: 3,
    custom_rules: []
  };
  assert.match(
    validateRegenerationDiversity(
      previousDraft,
      previousDraft,
      expandedDishes,
      preferences
    )[0],
    /at least 3 must differ/
  );

  let calls = 0;
  const result = await generateCandidateWithRetries({
    prompt: "regenerate",
    dishes: expandedDishes,
    preferences,
    recentMenus: [],
    previousDraft,
    weekStart: "2026-07-27",
    completionFn: async () => {
      calls += 1;
      return calls === 1 ? previousDraft : replacement;
    }
  });
  assert.equal(calls, 2);
  assert.deepEqual(result, replacement);
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
