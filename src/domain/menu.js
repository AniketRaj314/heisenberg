import { z } from "zod";
import { parseCustomRule } from "./preferences.js";

export const MENU_DAYS = ["Monday", "Tuesday", "Thursday", "Friday", "Saturday"];
export const MENU_SLOTS = ["carb_heavy", "chicken_main", "paneer_main", "sabzi", "random"];

const MenuDaySchema = z.object({
  day: z.enum(MENU_DAYS),
  slot_type: z.enum(MENU_SLOTS),
  main_dish: z.string().trim().min(1).max(200),
  side_chicken: z.string().trim().min(1).max(200).nullable(),
  prep_notes: z.string().max(1000),
  cook_notes: z.string().max(1000)
}).strict();

export const MenuDraftSchema = z.object({
  week_start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  days: z.array(MenuDaySchema).length(5)
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

function recentMainNames(recentMenus, weeks) {
  if (weeks <= 0) return new Set();
  const protectedWeeks = [];
  for (const menu of recentMenus) {
    if (!protectedWeeks.includes(menu.week_start)) protectedWeeks.push(menu.week_start);
    if (protectedWeeks.length >= weeks) break;
  }
  return new Set(
    recentMenus
      .filter((menu) => protectedWeeks.includes(menu.week_start))
      .flatMap((menu) => menu.days ?? [])
      .map((entry) => entry.main_dish)
      .filter(Boolean)
  );
}

export function parseMenuDraft(menu) {
  return MenuDraftSchema.parse(menu);
}

export function validateMenu(
  menu,
  dishes,
  preferences,
  expectedWeekStart,
  recentMenus = []
) {
  const parsed = MenuDraftSchema.safeParse(menu);
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
  const slots = candidate.days.map((entry) => entry.slot_type);
  if (new Set(days).size !== MENU_DAYS.length || MENU_DAYS.some((day) => !days.includes(day))) {
    errors.push("required weekdays must each appear exactly once");
  }
  if (new Set(slots).size !== MENU_SLOTS.length || MENU_SLOTS.some((slot) => !slots.includes(slot))) {
    errors.push("required slots must each appear exactly once");
  }

  const mainNames = candidate.days.map((entry) => entry.main_dish);
  if (new Set(mainNames).size !== mainNames.length) errors.push("main dishes repeat");

  let paneerCount = 0;
  let carbCount = 0;
  let tandooriUsed = false;

  for (const entry of candidate.days) {
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
    if (banned.some((term) => normalize(main.name).includes(term))) {
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
      if (hasEligibleSide) errors.push(`${entry.day} is missing a dry-chicken side`);
      continue;
    }
    const side = byName.get(entry.side_chicken);
    if (!side || side.category !== "dry_chicken") {
      errors.push(`invalid side chicken: ${entry.side_chicken}`);
      continue;
    }
    if (banned.some((term) => normalize(side.name).includes(term))) {
      errors.push(`${side.name} is banned`);
    }
    if (entry.day === "Monday" && side.name === "Tandoori Chicken") {
      errors.push("Tandoori Chicken cannot be used Monday");
    }
    if (side.name === "Tandoori Chicken") tandooriUsed = true;
  }

  if (paneerCount > preferences.max_paneer_per_week) {
    errors.push("paneer maximum exceeded");
  }
  if (carbCount > preferences.max_carb_heavy_per_week) {
    errors.push("carb-heavy maximum exceeded");
  }
  for (const rule of customRules) {
    if (rule.type === "max_category") {
      const count = candidate.days.filter(
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
      candidate.days.some(
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
  const scheduledDays = MENU_DAYS.map((day) =>
    candidate.days.find((entry) => entry.day === day)
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

  const pairIndexes = ["Dosa Chutney", "Sandwich"].map((name) =>
    candidate.days.findIndex((entry) => entry.main_dish === name)
  );
  if (pairIndexes.some((index) => index >= 0)) {
    if (pairIndexes.some((index) => index < 0) || Math.abs(pairIndexes[0] - pairIndexes[1]) !== 1) {
      errors.push("Dosa Chutney and Sandwich must occur together on adjacent scheduled days");
    } else {
      const pairNotes = pairIndexes.map((index) => candidate.days[index].prep_notes).join(" ");
      if (!mentionsSharedMasalaAloo(pairNotes)) {
        errors.push("Dosa Chutney and Sandwich need a prep note about shared masala aloo");
      }
    }
  }

  if (
    tandooriUsed &&
    !candidate.days.some((entry) => mentionsTandooriPrep(entry.prep_notes))
  ) {
    errors.push("Tandoori Chicken needs an overnight-marination prep note");
  }

  const weeksToAvoid = preferences.cross_week_avoid_last_n_weeks ?? 0;
  const recentlyUsed = recentMainNames(recentMenus, weeksToAvoid);
  for (const entry of candidate.days) {
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
