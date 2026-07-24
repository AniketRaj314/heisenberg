export function buildMenuGenerationPrompt({ weekStart, dishes, preferences, recentMenus }) {
  return `Create the weekly dinner menu for a household of two.

The user is pre-diabetic, limits rotis to one, prioritises protein, and avoids high-GI meals as a daily habit. His brother has no dietary restrictions and prefers weight-loss-friendly meals.

Target week starts: ${weekStart}

ACTIVE DISHES:
${JSON.stringify(dishes)}

PREFERENCES:
${JSON.stringify(preferences)}

RECENT MENUS (newest history may be relevant for rotation):
${JSON.stringify(recentMenus)}

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
- Dry-chicken sides may repeat within the week, but the same side must not appear on consecutive scheduled meal days. Do not invent a side.
- Respect needs_overnight_marination: add a prior-day prep note when Tandoori Chicken is used.
- Avoid main dishes used in the last ${preferences.cross_week_avoid_last_n_weeks ?? 3} weeks unless the available rotation is exhausted.
- Treat every entry in preferences.custom_rules as mandatory.
- Days are dynamic; do not fix a slot to a particular weekday.

Return valid JSON only (no markdown or backticks):
{
  "week_start": "${weekStart}",
  "days": [{
    "day": "Monday",
    "slot_type": "carb_heavy",
    "main_dish": "Whole Wheat Hakka Noodles",
    "side_chicken": "Lemon Pepper Chicken",
    "prep_notes": "",
    "cook_notes": ""
  }]
}`;
}
