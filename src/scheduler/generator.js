import OpenAI from "openai";
import {
  getDishes,
  getMenus,
  getPreferences,
  saveMenu
} from "../db/store.js";
import { validateMenu } from "../domain/menu.js";
import { buildMenuGenerationPrompt } from "../prompts/menu_generation.js";
import { createRateLimiter } from "../security/rateLimit.js";

export { MENU_DAYS, MENU_SLOTS, validateMenu } from "../domain/menu.js";

const manualGenerationLimiter = createRateLimiter({
  limit: 3,
  windowMs: 10 * 60_000
});
let generationInFlight = null;

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
  weekStart,
  completionFn = createCompletion,
  attempts = 3
}) {
  let menu;
  let errors = [];
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const correction = errors.length
      ? `\n\nYour previous result was invalid. Correct every issue: ${errors.join("; ")}`
      : "";
    try {
      menu = await completionFn(prompt, correction);
      errors = validateMenu(menu, dishes, preferences, weekStart, recentMenus);
      if (!errors.length) return menu;
    } catch (error) {
      errors = [`attempt ${attempt + 1} failed: ${error.message}`];
    }
  }
  throw new Error(`AI menu failed validation: ${errors.join("; ")}`);
}

async function generateMenuInternal({
  weekStart = getMonday(),
  notify,
  completionFn
} = {}) {
  const [dishes, preferences, allMenus] = await Promise.all([
    getDishes({ activeOnly: true }),
    getPreferences(),
    getMenus()
  ]);
  const recentMenus = allMenus
    .filter((menu) => menu.week_start < weekStart)
    .sort((a, b) => b.week_start.localeCompare(a.week_start))
    .slice(0, Math.max(4, preferences.cross_week_avoid_last_n_weeks ?? 0));
  const prompt = buildMenuGenerationPrompt({
    weekStart,
    dishes,
    preferences,
    recentMenus
  });

  const menu = await generateCandidateWithRetries({
    prompt,
    dishes,
    preferences,
    recentMenus,
    weekStart,
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
