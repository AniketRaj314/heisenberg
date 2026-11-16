import { MAX_PREVIOUS_WEEK_REPEATS } from "../domain/menu.js";

export function buildMenuGenerationPrompt({
  weekStart,
  dishes,
  preferences,
  recentMenus,
  recentMeals = [],
  householdContext = [],
  previousDraft = null,
  eligibility = null
}) {
  return `Create the weekly dinner menu for a household of two.

The user is pre-diabetic, limits rotis to one, prioritises protein, and avoids high-GI meals as a daily habit. His brother has no dietary restrictions and prefers weight-loss-friendly meals.

Target week starts: ${weekStart}

ACTIVE DISHES:
${JSON.stringify(dishes)}

PREFERENCES:
${JSON.stringify(preferences)}

PREVIOUS WEEK MENU (the only menu used for cross-week rotation; empty if missing):
${JSON.stringify(recentMenus)}

PREVIOUS WEEK ACTUAL MEALS (soft context, not additional repeat restrictions):
${JSON.stringify(recentMeals)}

HOUSEHOLD PLANNING CONTEXT (soft guidance, newest first):
${JSON.stringify(householdContext)}

CURRENT DRAFT BEING REPLACED:
${JSON.stringify(previousDraft)}

SERVER-COMPUTED ELIGIBILITY:
${JSON.stringify(eligibility)}

GUARDRAILS:
- Return exactly Monday, Tuesday, Thursday, Friday, Saturday.
- Assign each slot_type exactly once: carb_heavy, chicken_main, paneer_main, sabzi, random.
- Use only active dish names from ACTIVE DISHES.
- A non-random slot must use a dish from its matching category.
- The random slot may use any non-dry-chicken main dish.
- Tandoori Chicken is never allowed on Monday.
- Never use bhindi or anything listed in preferences.never_use.
- Carb-heavy dishes may occur at most ${preferences.max_carb_heavy_per_week} time(s), including the random slot.
- Paneer dishes may occur at most ${preferences.max_paneer_per_week} time(s), including the random slot.
- No main dish may repeat within the week.
- If Dosa Chutney or Sandwich appears, both must appear in the same week on adjacent scheduled days. Add a prep note explaining that their masala aloo is shared.
- Each meal has exactly one substantial main dish. Never pair two main-category dishes.
- Assign exactly one dry_chicken side on every day except chicken_main day.
- A chicken_main is complete on its own and must have side_chicken set to null.
- Only a dry_chicken dish is valid in side_chicken; never use a sabzi, paneer_main, carb_heavy, or chicken_main as a side.
- Use every eligible active dry_chicken side before repeating one. If repeats are necessary, distribute them as evenly as possible.
- Dry-chicken sides may repeat within the week, but the same side must not appear on consecutive scheduled meal days. Do not invent a side.
- Respect needs_overnight_marination: add a prior-day prep note when Tandoori Chicken is used.
- Compare only with PREVIOUS WEEK MENU. At most ${MAX_PREVIOUS_WEEK_REPEATS} distinct main dishes from that menu may appear this week, even on different weekdays. Older menus do not restrict choices.
- This repeat limit is mandatory even when the dish pool is small. Chicken sides do not count toward it. If no previous-week menu exists, there is no cross-week repeat restriction.
- Use PREVIOUS WEEK ACTUAL MEALS as soft guidance for recent meals and sides; they do not add dishes to the previous-menu repeat count.
- When CURRENT DRAFT BEING REPLACED is present, this is a genuine regeneration: choose new main dishes rather than returning or merely reshuffling the same menu. Change at least three of the five mains when eligible alternatives exist.
- Treat every entry in preferences.custom_rules as mandatory.
- Apply relevant HOUSEHOLD PLANNING CONTEXT using culinary judgment. It is soft guidance unless the memory clearly records a household requirement.
- Days are dynamic; do not fix a slot to a particular weekday.
- The carb_heavy slot must not be scheduled on Monday.
- For every slot, prefer its preferred eligibility list (mains not in the previous menu). You may also use repeat_candidates, but across the entire menu at most ${MAX_PREVIOUS_WEEK_REPEATS} mains may repeat. Never relax this limit when alternatives are exhausted.
- For the random slot, its eligibility list already accounts for category quotas; do not substitute another dish.

Return valid JSON only (no markdown or backticks):
{
  "week_start": "${weekStart}",
  "days": [{
    "day": "Monday",
    "slot_type": "chicken_main",
    "main_dish": "Chicken Curry",
    "side_chicken": null,
    "prep_notes": "",
    "cook_notes": ""
  }]
}`;
}
