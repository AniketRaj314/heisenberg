import { z } from "zod";

const categories = ["carb_heavy", "chicken_main", "paneer_main", "sabzi", "dry_chicken"];
const days = ["monday", "tuesday", "thursday", "friday", "saturday"];

export function parseCustomRule(rule) {
  const value = rule.trim();
  if (value.startsWith("never:") && value.slice(6).trim()) {
    return { type: "never", term: value.slice(6).trim() };
  }
  const maxCategory = value.match(/^max_category:([^:]+):(\d+)$/);
  if (
    maxCategory &&
    categories.includes(maxCategory[1]) &&
    Number(maxCategory[2]) >= 0 &&
    Number(maxCategory[2]) <= 5
  ) {
    return {
      type: "max_category",
      category: maxCategory[1],
      count: Number(maxCategory[2])
    };
  }
  if (value.startsWith("require_main:") && value.slice(13).trim()) {
    return { type: "require_main", dish: value.slice(13).trim() };
  }
  const notOn = value.match(/^not_on:([^:]+):(.+)$/);
  if (notOn && days.includes(notOn[1].toLowerCase()) && notOn[2].trim()) {
    return { type: "not_on", day: notOn[1], dish: notOn[2].trim() };
  }
  const pair = value.match(/^pair:([^|]+)\|(.+)$/);
  if (pair && pair[1].trim() && pair[2].trim()) {
    return { type: "pair", dishes: [pair[1].trim(), pair[2].trim()] };
  }
  throw new Error(
    `Unsupported custom rule "${rule}". Use never:<term>, max_category:<category>:<0-5>, ` +
      "require_main:<dish>, not_on:<day>:<dish>, or pair:<dish>|<dish>."
  );
}

const CustomRuleSchema = z.string().trim().min(1).max(500).superRefine((rule, context) => {
  try {
    parseCustomRule(rule);
  } catch (error) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: error.message });
  }
});

export const PreferencesSchema = z.object({
  max_carb_heavy_per_week: z.number().int().min(1).max(5),
  max_paneer_per_week: z.number().int().min(1).max(5),
  never_use: z.array(z.string().trim().min(1).max(100)).max(100),
  cross_week_avoid_last_n_weeks: z.number().int().min(0).max(52),
  custom_rules: z.array(CustomRuleSchema).max(50)
}).strict();

const preferenceValueSchemas = Object.fromEntries(
  Object.entries(PreferencesSchema.shape)
);

export function parsePreferences(preferences) {
  return PreferencesSchema.parse(preferences);
}

export function parsePreferenceUpdate(key, value) {
  if (!Object.hasOwn(preferenceValueSchemas, key)) {
    throw new Error(`Unknown preference: ${key}`);
  }
  return preferenceValueSchemas[key].parse(value);
}
