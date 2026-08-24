import { z } from "zod";
import { parseCustomRule } from "./preferences.js";

export const WEEKDAYS = [
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday"
];
export const MENU_DAYS = ["Monday", "Tuesday", "Thursday", "Friday", "Saturday"];
export const MENU_SLOTS = ["carb_heavy", "chicken_main", "paneer_main", "sabzi", "random"];
export const MEAL_STATUSES = ["planned", "dining_out", "skipped"];

const GeneratedMenuDaySchema = z.object({
  day: z.enum(WEEKDAYS),
  slot_type: z.enum(MENU_SLOTS),
  main_dish: z.string().trim().min(1).max(200),
  side_chicken: z.string().trim().min(1).max(200).nullable(),
  prep_notes: z.string().max(1000),
  cook_notes: z.string().max(1000)
}).strict();

export const MenuDraftSchema = z.object({
  week_start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  days: z.array(GeneratedMenuDaySchema).length(5)
}).strict();

const StoredMenuDaySchema = z.object({
  day: z.enum(WEEKDAYS),
  meal_status: z.enum(MEAL_STATUSES).default("planned"),
  slot_type: z.enum(MENU_SLOTS).nullable(),
  main_dish: z.string().trim().min(1).max(200).nullable(),
  side_chicken: z.string().trim().min(1).max(200).nullable(),
  prep_notes: z.string().max(1000),
  cook_notes: z.string().max(1000)
}).strict().superRefine((entry, context) => {
  if (entry.meal_status === "planned") {
    if (!entry.slot_type) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["slot_type"], message: "is required for a planned meal" });
    }
    if (!entry.main_dish) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["main_dish"], message: "is required for a planned meal" });
    }
    return;
  }
  if (entry.slot_type || entry.main_dish || entry.side_chicken) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: `${entry.meal_status} days cannot contain planned dishes`
    });
  }
});

export const StoredMenuDraftSchema = z.object({
  week_start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  days: z.array(StoredMenuDaySchema).max(WEEKDAYS.length)
}).strict();

function normalize(value) {
  return String(value).trim().toLowerCase();
}

function mentionsSharedMasalaAloo(text) {
  const value = normalize(text);
  return value.includes("masala") && value.includes("aloo") && value.includes("shar");
}

function mentionsTandooriPrep(text) {
  const value = normalize(text);
  return (
    value.includes("tandoori") &&
    (value.includes("marinat") || value.includes("overnight"))
  );
}

export function protectedMainNames({
  recentMenus = [],
  recentMeals = [],
  weeks = 0,
  weekStart
}) {
  if (weeks <= 0) return new Set();
  const protectedWeeks = [];
  const eligibleMenus = recentMenus.filter(
    (menu) =>
      !menu.status || ["active", "confirmed"].includes(menu.status)
  );
  for (const menu of eligibleMenus) {
    if (!protectedWeeks.includes(menu.week_start)) protectedWeeks.push(menu.week_start);
    if (protectedWeeks.length >= weeks) break;
  }
  const names = eligibleMenus
      .filter((menu) => protectedWeeks.includes(menu.week_start))
      .flatMap((menu) => menu.days ?? [])
      .map((entry) => entry.main_dish)
      .filter(Boolean);

  if (weekStart) {
    const cutoff = new Date(`${weekStart}T00:00:00Z`);
    cutoff.setUTCDate(cutoff.getUTCDate() - weeks * 7);
    const cutoffDate = cutoff.toISOString().slice(0, 10);
    names.push(
      ...recentMeals
        .filter(
          (meal) =>
            meal.date >= cutoffDate &&
            meal.date < weekStart &&
            meal.main_dish
        )
        .map((meal) => meal.main_dish)
    );
  }

  return new Set(names);
}

export function buildGenerationEligibility({
  dishes,
  preferences,
  recentMenus = [],
  recentMeals = [],
  weekStart
}) {
  const customRules = (preferences.custom_rules ?? []).map(parseCustomRule);
  const banned = [
    ...(preferences.never_use ?? []),
    ...customRules.filter((rule) => rule.type === "never").map((rule) => rule.term)
  ].map(normalize);
  const active = dishes.filter(
    (dish) =>
      dish.active &&
      !banned.some((term) => normalize(dish.name).includes(term))
  );
  const recentlyUsed = protectedMainNames({
    recentMenus,
    recentMeals,
    weeks: preferences.cross_week_avoid_last_n_weeks ?? 0,
    weekStart
  });
  const categoryCaps = new Map(
    customRules
      .filter((rule) => rule.type === "max_category")
      .map((rule) => [rule.category, rule.count])
  );
  categoryCaps.set(
    "paneer_main",
    Math.min(
      categoryCaps.get("paneer_main") ?? Infinity,
      preferences.max_paneer_per_week
    )
  );
  categoryCaps.set(
    "carb_heavy",
    Math.min(
      categoryCaps.get("carb_heavy") ?? Infinity,
      preferences.max_carb_heavy_per_week
    )
  );

  const candidatesForSlot = (slot) =>
    active.filter((dish) => {
      if (dish.category === "dry_chicken") return false;
      if (slot !== "random") return dish.category === slot;
      const cap = categoryCaps.get(dish.category);
      return cap === undefined || cap > 1;
    });
  const mainDishes = Object.fromEntries(
    MENU_SLOTS.map((slot) => {
      const candidates = candidatesForSlot(slot);
      const preferred = candidates.filter((dish) => !recentlyUsed.has(dish.name));
      return [
        slot,
        {
          preferred: preferred.map((dish) => dish.name),
          history_fallback:
            preferred.length === 0 ? candidates.map((dish) => dish.name) : []
        }
      ];
    })
  );
  const sides = active
    .filter((dish) => dish.category === "dry_chicken")
    .map((dish) => dish.name);

  return {
    protected_main_dishes: [...recentlyUsed],
    main_dishes_by_slot: mainDishes,
    dry_chicken_sides: sides,
    slot_day_constraints: {
      carb_heavy: MENU_DAYS.filter((day) => day !== "Monday")
    },
    side_day_constraints: {
      Monday: sides.filter((name) => name !== "Tandoori Chicken")
    }
  };
}

export function parseMenuDraft(menu) {
  return MenuDraftSchema.parse(menu);
}

export function validateMenu(
  menu,
  dishes,
  preferences,
  expectedWeekStart,
  recentMenus = [],
  { requiredDays = MENU_DAYS, mode = "generation", recentMeals = [] } = {}
) {
  const enforcePlanningPolicy = mode === "generation";
  const parsed = (enforcePlanningPolicy ? MenuDraftSchema : StoredMenuDraftSchema).safeParse(menu);
  if (!parsed.success) {
    return parsed.error.issues.map(
      (issue) => `${issue.path.join(".") || "menu"}: ${issue.message}`
    );
  }

  const candidate = parsed.data;
  const errors = [];
  const active = dishes.filter((dish) => dish.active);
  const byName = new Map(active.map((dish) => [dish.name, dish]));
  const customRules = (preferences.custom_rules ?? []).map(parseCustomRule);
  const banned = [
    ...(preferences.never_use ?? []),
    ...customRules.filter((rule) => rule.type === "never").map((rule) => rule.term)
  ].map(normalize);
  const availableDryChickenNames = new Set(
    active
      .filter(
        (dish) =>
          dish.category === "dry_chicken" &&
          !banned.some((term) => normalize(dish.name).includes(term))
      )
      .map((dish) => dish.name)
  );

  if (candidate.week_start !== expectedWeekStart) errors.push("week_start is incorrect");

  const days = candidate.days.map((entry) => entry.day);
  const plannedEntries = candidate.days.filter(
    (entry) => (entry.meal_status ?? "planned") === "planned"
  );
  const slots = plannedEntries.map((entry) => entry.slot_type);
  if (new Set(days).size !== candidate.days.length) {
    errors.push("scheduled weekdays must be unique");
  }
  if (
    enforcePlanningPolicy &&
    requiredDays &&
    (days.length !== requiredDays.length ||
      requiredDays.some((day) => !days.includes(day)))
  ) {
    errors.push("required weekdays must each appear exactly once");
  }
  if (
    enforcePlanningPolicy &&
    (new Set(slots).size !== MENU_SLOTS.length || MENU_SLOTS.some((slot) => !slots.includes(slot)))
  ) {
    errors.push("required slots must each appear exactly once");
  }

  const mainNames = plannedEntries.map((entry) => entry.main_dish);
  if (enforcePlanningPolicy && new Set(mainNames).size !== mainNames.length) {
    errors.push("main dishes repeat");
  }

  let paneerCount = 0;
  let carbCount = 0;
  let tandooriUsed = false;

  for (const entry of candidate.days) {
    if ((entry.meal_status ?? "planned") !== "planned") continue;
    const main = byName.get(entry.main_dish);
    if (!main) {
      errors.push(`inactive or unknown main dish: ${entry.main_dish}`);
      continue;
    }
    if (main.category === "dry_chicken") errors.push(`${main.name} cannot be a main dish`);
    if (entry.slot_type !== "random" && main.category !== entry.slot_type) {
      errors.push(`${main.name} does not match slot ${entry.slot_type}`);
    }
    if (main.category === "paneer_main") paneerCount += 1;
    if (main.category === "carb_heavy") carbCount += 1;
    if (enforcePlanningPolicy && banned.some((term) => normalize(main.name).includes(term))) {
      errors.push(`${main.name} is banned`);
    }

    const mainIsChicken = main.category === "chicken_main";
    if (mainIsChicken) {
      if (entry.side_chicken) errors.push(`${entry.day} has a chicken main and cannot have a side chicken`);
      continue;
    }

    if (!entry.side_chicken) {
      const hasEligibleSide = [...availableDryChickenNames].some(
        (name) => !(entry.day === "Monday" && name === "Tandoori Chicken")
      );
      if (enforcePlanningPolicy && hasEligibleSide) {
        errors.push(`${entry.day} is missing a dry-chicken side`);
      }
      continue;
    }
    const side = byName.get(entry.side_chicken);
    if (!side || side.category !== "dry_chicken") {
      errors.push(`invalid side chicken: ${entry.side_chicken}`);
      continue;
    }
    if (enforcePlanningPolicy && banned.some((term) => normalize(side.name).includes(term))) {
      errors.push(`${side.name} is banned`);
    }
    if (enforcePlanningPolicy && entry.day === "Monday" && side.name === "Tandoori Chicken") {
      errors.push("Tandoori Chicken cannot be used Monday");
    }
    if (side.name === "Tandoori Chicken") tandooriUsed = true;
  }

  // Direct user edits are explicit overrides. Persistence still protects the
  // shape and dish references above; rotation, quotas, history and prep rules
  // remain generation policy owned by the planner.
  if (!enforcePlanningPolicy) return [...new Set(errors)];

  if (paneerCount > preferences.max_paneer_per_week) {
    errors.push("paneer maximum exceeded");
  }
  if (carbCount > preferences.max_carb_heavy_per_week) {
    errors.push("carb-heavy maximum exceeded");
  }
  for (const rule of customRules) {
    if (rule.type === "max_category") {
      const count = plannedEntries.filter(
        (entry) => byName.get(entry.main_dish)?.category === rule.category
      ).length;
      if (count > rule.count) {
        errors.push(`custom rule exceeded: max ${rule.count} ${rule.category} main(s)`);
      }
    }
    if (rule.type === "require_main" && !mainNames.includes(rule.dish)) {
      errors.push(`custom rule requires main dish: ${rule.dish}`);
    }
    if (
      rule.type === "not_on" &&
      plannedEntries.some(
        (entry) =>
          normalize(entry.day) === normalize(rule.day) &&
          normalize(entry.main_dish) === normalize(rule.dish)
      )
    ) {
      errors.push(`custom rule forbids ${rule.dish} on ${rule.day}`);
    }
    if (rule.type === "pair") {
      const present = rule.dishes.map((dish) =>
        mainNames.some((mainName) => normalize(mainName) === normalize(dish))
      );
      if (present.some(Boolean) && !present.every(Boolean)) {
        errors.push(`custom rule pairs ${rule.dishes.join(" with ")}`);
      }
    }
  }
  const scheduledDays = [...plannedEntries].sort(
    (a, b) => WEEKDAYS.indexOf(a.day) - WEEKDAYS.indexOf(b.day)
  );
  for (let index = 1; index < scheduledDays.length; index += 1) {
    const previousSide = scheduledDays[index - 1]?.side_chicken;
    const currentSide = scheduledDays[index]?.side_chicken;
    if (previousSide && currentSide && previousSide === currentSide) {
      errors.push(
        `${currentSide} repeats on consecutive scheduled days: ` +
        `${scheduledDays[index - 1].day} and ${scheduledDays[index].day}`
      );
    }
  }

  const sideCounts = scheduledDays.reduce((counts, entry) => {
    if (entry.side_chicken) {
      counts.set(entry.side_chicken, (counts.get(entry.side_chicken) ?? 0) + 1);
    }
    return counts;
  }, new Map());
  const unusedSides = [...availableDryChickenNames].filter(
    (name) => !sideCounts.has(name)
  );
  const repeatedSides = [...sideCounts]
    .filter(([, count]) => count > 1)
    .map(([name]) => name);
  const usableUnusedSides = unusedSides.filter((name) =>
    scheduledDays.some(
      (entry) =>
        byName.get(entry.main_dish)?.category !== "chicken_main" &&
        !(entry.day === "Monday" && name === "Tandoori Chicken")
    )
  );
  if (repeatedSides.length && usableUnusedSides.length) {
    errors.push(
      `${repeatedSides.join(", ")} repeats before eligible sides are used: ` +
      usableUnusedSides.join(", ")
    );
  }

  const pairIndexes = ["Dosa Chutney", "Sandwich"].map((name) =>
    scheduledDays.findIndex((entry) => entry.main_dish === name)
  );
  if (pairIndexes.some((index) => index >= 0)) {
    if (pairIndexes.some((index) => index < 0) || Math.abs(pairIndexes[0] - pairIndexes[1]) !== 1) {
      errors.push("Dosa Chutney and Sandwich must occur together on adjacent scheduled days");
    } else {
      const pairNotes = pairIndexes.map((index) => scheduledDays[index].prep_notes).join(" ");
      if (!mentionsSharedMasalaAloo(pairNotes)) {
        errors.push("Dosa Chutney and Sandwich need a prep note about shared masala aloo");
      }
    }
  }

  if (
    tandooriUsed &&
    !plannedEntries.some((entry) => mentionsTandooriPrep(entry.prep_notes))
  ) {
    errors.push("Tandoori Chicken needs an overnight-marination prep note");
  }

  const mondayCarb = plannedEntries.some(
    (entry) => entry.day === "Monday" && entry.slot_type === "carb_heavy"
  );
  if (mondayCarb) errors.push("carb-heavy slot cannot be scheduled on Monday");

  const weeksToAvoid = preferences.cross_week_avoid_last_n_weeks ?? 0;
  const recentlyUsed = protectedMainNames({
    recentMenus,
    recentMeals,
    weeks: weeksToAvoid,
    weekStart: expectedWeekStart
  });
  for (const entry of plannedEntries) {
    if (!recentlyUsed.has(entry.main_dish)) continue;
    const main = byName.get(entry.main_dish);
    if (!main) continue;
    const alternatives = active.filter((dish) => {
      if (dish.category === "dry_chicken") return false;
      if (entry.slot_type !== "random" && dish.category !== entry.slot_type) return false;
      if (recentlyUsed.has(dish.name) || mainNames.includes(dish.name)) return false;
      if (dish.category === "paneer_main" && paneerCount >= preferences.max_paneer_per_week) {
        return false;
      }
      if (dish.category === "carb_heavy" && carbCount >= preferences.max_carb_heavy_per_week) {
        return false;
      }
      return !banned.some((term) => normalize(dish.name).includes(term));
    });
    if (alternatives.length) {
      errors.push(`${entry.main_dish} repeats within the protected history while alternatives remain`);
    }
  }

  return [...new Set(errors)];
}
