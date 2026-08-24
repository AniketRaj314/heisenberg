import OpenAI from "openai";
import {
  getDishes,
  getMealHistory,
  getMenus,
  getPreferences,
  searchContext,
  saveMenu
} from "../db/store.js";
import {
  buildGenerationEligibility,
  normalizeGeneratedMenu,
  validateMenu
} from "../domain/menu.js";
import { buildMenuGenerationPrompt } from "../prompts/menu_generation.js";
import { createRateLimiter } from "../security/rateLimit.js";

export { MENU_DAYS, MENU_SLOTS, validateMenu } from "../domain/menu.js";

const manualGenerationLimiter = createRateLimiter({
  limit: 3,
  windowMs: 10 * 60_000
});
let generationInFlight = null;

export class MenuGenerationError extends Error {
  constructor(errors, attempts) {
    super(`AI menu failed validation: ${errors.join("; ")}`);
    this.name = "MenuGenerationError";
    this.code = "MENU_GENERATION_VALIDATION_FAILED";
    this.validationErrors = [...errors];
    this.attempts = attempts;
  }
}

export function formatMenuGenerationFailure(error) {
  if (error instanceof MenuGenerationError) {
    const conflicts = error.validationErrors
      .slice(0, 3)
      .map((message) => `• ${message}`)
      .join("\n");
    return (
      `I couldn't assemble a valid draft after ${error.attempts} attempts, ` +
      `so nothing was saved.\n\nLast conflicts:\n${conflicts}\n\n` +
      "Try /generate again. If this keeps happening, the dish rotation may need more eligible options."
    );
  }
  if (/rate-limited/i.test(error?.message ?? "")) return error.message;
  return "I couldn't generate a menu right now. Nothing was saved; please try again shortly.";
}

export function getTimeZone() {
  return process.env.TZ || "Asia/Kolkata";
}

function dateInTimeZone(date = new Date(), timeZone = getTimeZone()) {
  return new Date(
    new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }).format(date) + "T00:00:00Z"
  );
}

export function getMonday(offsetWeeks = 0, from = new Date()) {
  const date = dateInTimeZone(from);
  const day = date.getUTCDay();
  const daysUntilMonday = day === 0 ? 1 : 8 - day;
  date.setUTCDate(date.getUTCDate() + daysUntilMonday + offsetWeeks * 7);
  return date.toISOString().slice(0, 10);
}

function extractJson(text) {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  return JSON.parse(cleaned);
}

async function createCompletion(prompt, correction = "") {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is required to generate a menu.");
  }
  const client = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
    timeout: 60_000,
    maxRetries: 2
  });
  const completion = await client.chat.completions.create({
    model:
      process.env.OPENAI_MENU_MODEL ||
      process.env.OPENAI_MODEL ||
      "gpt-5.6-luna",
    response_format: { type: "json_object" },
    max_completion_tokens: 3000,
    messages: [
      { role: "system", content: "You create valid weekly meal plans and return JSON only." },
      { role: "user", content: `${prompt}${correction}` }
    ]
  });
  return extractJson(completion.choices[0]?.message?.content ?? "");
}

export async function generateCandidateWithRetries({
  prompt,
  dishes,
  preferences,
  recentMenus,
  recentMeals = [],
  previousDraft = null,
  weekStart,
  eligibility = null,
  completionFn = createCompletion,
  attempts = 3
}) {
  let menu;
  let errors = [];
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const correction = errors.length
      ? `\n\nYour previous result was invalid. Correct every issue: ${errors.join("; ")}` +
        `\nUse these exact server-computed eligible choices:\n${JSON.stringify(eligibility)}`
      : "";
    try {
      menu = normalizeGeneratedMenu(await completionFn(prompt, correction));
      errors = validateMenu(menu, dishes, preferences, weekStart, recentMenus, {
        recentMeals
      });
      errors.push(
        ...validateRegenerationDiversity(
          menu,
          previousDraft,
          dishes,
          preferences
        )
      );
      if (!errors.length) return menu;
    } catch (error) {
      errors = [`attempt ${attempt + 1} failed: ${error.message}`];
    }
  }
  throw new MenuGenerationError(errors, attempts);
}

export function validateRegenerationDiversity(
  candidate,
  previousDraft,
  dishes,
  preferences
) {
  if (!previousDraft?.days?.length || !candidate?.days?.length) return [];
  const previousPlannedDays = previousDraft.days.filter(
    (entry) => (entry.meal_status ?? "planned") === "planned" && entry.main_dish
  );
  const previousMainNames = new Set(
    previousPlannedDays.map((entry) => entry.main_dish)
  );
  const banned = [
    ...(preferences.never_use ?? []),
    ...(preferences.custom_rules ?? [])
      .filter((rule) => String(rule).toLowerCase().startsWith("never:"))
      .map((rule) => String(rule).slice("never:".length))
  ].map((term) => term.trim().toLowerCase());
  const active = dishes.filter((dish) => dish.active);
  const changeableSlots = previousPlannedDays.filter((entry) =>
    active.some(
      (dish) =>
        dish.category !== "dry_chicken" &&
        !previousMainNames.has(dish.name) &&
        (entry.slot_type === "random" || dish.category === entry.slot_type) &&
        !banned.some((term) => dish.name.toLowerCase().includes(term))
    )
  ).length;
  const requiredChanges = Math.min(3, changeableSlots);
  const actualChanges = candidate.days.filter(
    (entry) => !previousMainNames.has(entry.main_dish)
  ).length;
  if (actualChanges >= requiredChanges) return [];
  return [
    `regeneration changes only ${actualChanges} main dish(es); at least ` +
    `${requiredChanges} must differ from the draft being replaced`
  ];
}

async function generateMenuInternal({
  weekStart = getMonday(),
  notify,
  completionFn
} = {}) {
  const [dishes, preferences, allMenus, recentMeals, householdContext] = await Promise.all([
    getDishes({ activeOnly: true }),
    getPreferences(),
    getMenus(),
    getMealHistory({ scopes: ["household"], limit: 30 }),
    searchContext({ scopes: ["household"], query: "", limit: 20 })
  ]);
  const recentMenus = allMenus
    .filter(
      (menu) =>
        menu.week_start < weekStart &&
        ["active", "confirmed"].includes(menu.status)
    )
    .sort((a, b) => b.week_start.localeCompare(a.week_start))
    .slice(0, Math.max(4, preferences.cross_week_avoid_last_n_weeks ?? 0));
  const previousDraft =
    allMenus
      .filter(
        (menu) =>
          menu.week_start === weekStart &&
          menu.status === "draft"
      )
      .sort((a, b) => b.generated_at.localeCompare(a.generated_at))[0] ?? null;
  const eligibility = buildGenerationEligibility({
    dishes,
    preferences,
    recentMenus,
    recentMeals,
    weekStart
  });
  const prompt = buildMenuGenerationPrompt({
    weekStart,
    dishes,
    preferences,
    recentMenus,
    recentMeals,
    householdContext,
    previousDraft,
    eligibility
  });

  const menu = await generateCandidateWithRetries({
    prompt,
    dishes,
    preferences,
    recentMenus,
    recentMeals,
    previousDraft,
    weekStart,
    eligibility,
    completionFn
  });
  const saved = await saveMenu(menu);
  if (notify) await notify(saved);
  return saved;
}

export function generateMenu(options = {}) {
  const { scheduled = false } = options;
  if (generationInFlight) return generationInFlight;
  if (!scheduled) {
    const limit = manualGenerationLimiter.consume("manual-generation");
    if (!limit.allowed) {
      const minutes = Math.max(1, Math.ceil(limit.retryAfterMs / 60_000));
      throw new Error(`Menu generation is rate-limited. Try again in about ${minutes} minute(s).`);
    }
  }
  generationInFlight = generateMenuInternal(options).finally(() => {
    generationInFlight = null;
  });
  return generationInFlight;
}
