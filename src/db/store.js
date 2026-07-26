import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { JSONFilePreset } from "lowdb/node";
import { z } from "zod";
import {
  parseMenuDraft,
  validateMenu,
  WEEKDAYS
} from "../domain/menu.js";
import {
  parsePreferences,
  parsePreferenceUpdate
} from "../domain/preferences.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.resolve(__dirname, "../data");

const files = {
  dishes: path.join(DATA_DIR, "dishes.json"),
  menus: path.join(DATA_DIR, "menus.json"),
  preferences: path.join(DATA_DIR, "preferences.json"),
  conversations: path.join(DATA_DIR, "conversations.json"),
  memories: path.join(DATA_DIR, "memories.json"),
  mealHistory: path.join(DATA_DIR, "meal_history.json")
};

const defaults = {
  dishes: { dishes: [] },
  menus: { menus: [] },
  preferences: {
    preferences: {
      max_carb_heavy_per_week: 1,
      max_paneer_per_week: 1,
      never_use: ["bhindi"],
      cross_week_avoid_last_n_weeks: 3,
      custom_rules: []
    }
  },
  conversations: { conversations: [] },
  memories: { memories: [] },
  mealHistory: { meals: [] }
};

const dbs = {};
let operationQueue = Promise.resolve();

const DishInputSchema = z.object({
  name: z.string().trim().min(1).max(200),
  category: z.enum(["carb_heavy", "chicken_main", "paneer_main", "sabzi", "dry_chicken"]),
  tags: z.array(z.string().trim().min(1).max(100)).max(50).default([])
}).strict();

const DishUpdateSchema = z.object({
  name_or_id: z.string().trim().min(1).max(200),
  name: z.string().trim().min(1).max(200).optional(),
  category: z.enum(["carb_heavy", "chicken_main", "paneer_main", "sabzi", "dry_chicken"]).optional(),
  tags: z.array(z.string().trim().min(1).max(100)).max(50).optional(),
  active: z.boolean().optional()
}).strict().refine(
  ({ name, category, tags, active }) =>
    name !== undefined || category !== undefined || tags !== undefined || active !== undefined,
  { message: "At least one dish field must be updated." }
);

const MemoryInputSchema = z.object({
  scope: z.string().regex(/^(household|person:[A-Za-z0-9_-]{1,100})$/),
  content: z.string().trim().min(1).max(2000),
  source: z.string().trim().min(1).max(100).default("agent"),
  createdBy: z.string().trim().min(1).max(100).nullable().default(null)
}).strict();

const MemorySearchSchema = z.object({
  scopes: z.array(
    z.string().regex(/^(household|person:[A-Za-z0-9_-]{1,100})$/)
  ).min(1).max(10),
  query: z.string().trim().max(1000).default(""),
  limit: z.number().int().min(1).max(50).default(10)
}).strict();

const MealRecordSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(
    (value) => {
      const parsed = new Date(`${value}T00:00:00Z`);
      return !Number.isNaN(parsed.valueOf()) &&
        parsed.toISOString().slice(0, 10) === value;
    },
    { message: "date must be a real calendar date" }
  ),
  scope: z.string().regex(/^(household|person:[A-Za-z0-9_-]{1,100})$/),
  main_dish: z.string().trim().min(1).max(200).nullable().optional(),
  side_chicken: z.string().trim().min(1).max(200).nullable().optional(),
  notes: z.string().trim().min(1).max(1000).nullable().optional(),
  source: z.string().trim().min(1).max(100).default("agent"),
  recordedBy: z.string().trim().min(1).max(100).nullable().default(null)
}).strict().refine(
  ({ main_dish, side_chicken }) =>
    main_dish !== undefined || side_chicken !== undefined,
  { message: "At least one consumed dish must be supplied." }
);

const MealHistoryQuerySchema = z.object({
  scopes: z.array(
    z.string().regex(/^(household|person:[A-Za-z0-9_-]{1,100})$/)
  ).min(1).max(10),
  limit: z.number().int().min(1).max(100).default(30)
}).strict();

function withStoreLock(operation) {
  const result = operationQueue.then(operation, operation);
  operationQueue = result.then(
    () => undefined,
    () => undefined
  );
  return result;
}

export async function initStore() {
  await mkdir(DATA_DIR, { recursive: true });
  await Promise.all(
    Object.entries(files).map(async ([name, filename]) => {
      dbs[name] = await JSONFilePreset(filename, defaults[name]);
      await dbs[name].write();
    })
  );
  return dbs;
}

function db(name) {
  if (!dbs[name]) throw new Error("Store has not been initialized.");
  return dbs[name];
}

export async function getDishes({ activeOnly = false } = {}) {
  return withStoreLock(async () => {
    await db("dishes").read();
    const dishes = db("dishes").data.dishes;
    return structuredClone(
      activeOnly ? dishes.filter((dish) => dish.active) : dishes
    );
  });
}

export async function addDish({ name, category, tags = [] }) {
  const input = DishInputSchema.parse({ name, category, tags });
  return withStoreLock(async () => {
    const dishesDb = db("dishes");
    await dishesDb.read();
    const existing = dishesDb.data.dishes.find(
      (dish) => dish.name.toLowerCase() === input.name.toLowerCase()
    );
    if (existing) throw new Error(`Dish already exists: ${existing.name}`);
    const dish = {
      id: randomUUID(),
      name: input.name,
      category: input.category,
      tags: [...new Set(input.tags)],
      active: true,
      created_at: new Date().toISOString()
    };
    dishesDb.data.dishes.push(dish);
    await dishesDb.write();
    return structuredClone(dish);
  });
}

export async function disableDish(nameOrId) {
  return withStoreLock(async () => {
    const dishesDb = db("dishes");
    await dishesDb.read();
    const dish = dishesDb.data.dishes.find(
      (item) =>
        item.id === nameOrId ||
        item.name.toLowerCase() === String(nameOrId).trim().toLowerCase()
    );
    if (!dish) throw new Error(`Dish not found: ${nameOrId}`);
    dish.active = false;
    await dishesDb.write();
    return structuredClone(dish);
  });
}

export async function updateDish(args) {
  const input = DishUpdateSchema.parse(args);
  return withStoreLock(async () => {
    const dishesDb = db("dishes");
    await dishesDb.read();
    const dish = dishesDb.data.dishes.find(
      (item) =>
        item.id === input.name_or_id ||
        item.name.toLowerCase() === input.name_or_id.toLowerCase()
    );
    if (!dish) throw new Error(`Dish not found: ${input.name_or_id}`);
    if (
      input.name &&
      dishesDb.data.dishes.some(
        (item) =>
          item.id !== dish.id &&
          item.name.toLowerCase() === input.name.toLowerCase()
      )
    ) {
      throw new Error(`Dish already exists: ${input.name}`);
    }
    if (input.name !== undefined) dish.name = input.name;
    if (input.category !== undefined) dish.category = input.category;
    if (input.tags !== undefined) dish.tags = [...new Set(input.tags)];
    if (input.active !== undefined) dish.active = input.active;
    dish.updated_at = new Date().toISOString();
    await dishesDb.write();
    return structuredClone(dish);
  });
}

export async function getPreferences() {
  return withStoreLock(async () => {
    await db("preferences").read();
    return structuredClone(parsePreferences(db("preferences").data.preferences));
  });
}

export async function updatePreference(key, value) {
  const parsedValue = parsePreferenceUpdate(key, value);
  return withStoreLock(async () => {
    const preferencesDb = db("preferences");
    await preferencesDb.read();
    const nextPreferences = {
      ...preferencesDb.data.preferences,
      [key]: parsedValue
    };
    preferencesDb.data.preferences = parsePreferences(nextPreferences);
    await preferencesDb.write();
    return structuredClone(preferencesDb.data.preferences);
  });
}

export async function getMenus() {
  return withStoreLock(async () => {
    await db("menus").read();
    return structuredClone(db("menus").data.menus);
  });
}

export async function saveMenu(menu) {
  const draft = parseMenuDraft(menu);
  return withStoreLock(async () => {
    const menusDb = db("menus");
    await menusDb.read();
    const saved = {
      week_start: draft.week_start,
      days: draft.days,
      id: randomUUID(),
      generated_at: new Date().toISOString(),
      status: "draft"
    };
    menusDb.data.menus = menusDb.data.menus.filter(
      (item) => !(item.week_start === saved.week_start && item.status === "draft")
    );
    menusDb.data.menus.push(saved);
    await menusDb.write();
    return structuredClone(saved);
  });
}

export async function getMenuForWeek(weekStart, statuses = []) {
  const menus = await getMenus();
  return (
    menus
      .filter(
        (menu) =>
          menu.week_start === weekStart &&
          (!statuses.length || statuses.includes(menu.status))
      )
      .sort((a, b) => b.generated_at.localeCompare(a.generated_at))[0] ?? null
  );
}

export async function getLatestDraft() {
  const menus = await getMenus();
  return (
    menus
      .filter((menu) => menu.status === "draft")
      .sort((a, b) => b.generated_at.localeCompare(a.generated_at))[0] ?? null
  );
}

export async function getRelevantMenu(currentWeekStart) {
  const menus = await getMenus();
  const byGeneratedAt = (a, b) => b.generated_at.localeCompare(a.generated_at);
  const current = menus
    .filter(
      (menu) =>
        menu.week_start === currentWeekStart &&
        ["active", "confirmed"].includes(menu.status)
    )
    .sort(byGeneratedAt)[0];
  if (current) return current;

  const draft = menus.filter((menu) => menu.status === "draft").sort(byGeneratedAt)[0];
  if (draft) return draft;

  const upcoming = menus
    .filter(
      (menu) =>
        menu.week_start > currentWeekStart &&
        ["active", "confirmed"].includes(menu.status)
    )
    .sort(
      (a, b) =>
        a.week_start.localeCompare(b.week_start) ||
        b.generated_at.localeCompare(a.generated_at)
    )[0];
  if (upcoming) return upcoming;

  return (
    menus
      .filter((menu) => ["active", "confirmed"].includes(menu.status))
      .sort(
        (a, b) =>
          b.week_start.localeCompare(a.week_start) ||
          b.generated_at.localeCompare(a.generated_at)
      )[0] ?? null
  );
}

export async function confirmMenu(menuId) {
  return withStoreLock(async () => {
    const menusDb = db("menus");
    await menusDb.read();
    const menu = menuId
      ? menusDb.data.menus.find((item) => item.id === menuId && item.status === "draft")
      : [...menusDb.data.menus]
          .filter((item) => item.status === "draft")
          .sort((a, b) => b.generated_at.localeCompare(a.generated_at))[0];
    if (!menu) throw new Error("No matching draft menu is available to confirm.");
    for (const item of menusDb.data.menus) {
      if (item.week_start === menu.week_start && item.id !== menu.id && item.status !== "draft") {
        item.status = "confirmed";
      }
    }
    menu.status = "active";
    await menusDb.write();
    return structuredClone(menu);
  });
}

export async function modifyMenuDay({ menuId, day, main_dish, side_chicken, prep_notes, cook_notes }) {
  return withStoreLock(async () => {
    const menusDb = db("menus");
    const dishesDb = db("dishes");
    const preferencesDb = db("preferences");
    await Promise.all([menusDb.read(), dishesDb.read(), preferencesDb.read()]);

    const storedMenu = menuId
      ? menusDb.data.menus.find((item) => item.id === menuId)
      : [...menusDb.data.menus].sort((a, b) => b.generated_at.localeCompare(a.generated_at))[0];
    if (!storedMenu) throw new Error("No menu is available.");

    const candidate = {
      week_start: storedMenu.week_start,
      days: structuredClone(storedMenu.days)
    };
    const entry = candidate.days.find(
      (item) => item.day.toLowerCase() === String(day).toLowerCase()
    );
    if (!entry) throw new Error(`Day is not in the menu: ${day}`);
    if (main_dish !== undefined) entry.main_dish = main_dish;
    if (side_chicken !== undefined) entry.side_chicken = side_chicken;
    if (prep_notes !== undefined) entry.prep_notes = prep_notes;
    if (cook_notes !== undefined) entry.cook_notes = cook_notes;

    const preferences = parsePreferences(preferencesDb.data.preferences);
    const recentMenus = menusDb.data.menus
      .filter((menu) => menu.week_start < candidate.week_start)
      .sort((a, b) => b.week_start.localeCompare(a.week_start));
    const errors = validateMenu(
      candidate,
      dishesDb.data.dishes,
      preferences,
      candidate.week_start,
      recentMenus,
      { requiredDays: null }
    );
    if (errors.length) {
      throw new Error(`Menu change violates guardrails: ${errors.join("; ")}`);
    }

    storedMenu.days = candidate.days;
    await menusDb.write();
    return structuredClone(storedMenu);
  });
}

function canonicalWeekday(value) {
  const normalized = String(value).trim().toLowerCase();
  const day = WEEKDAYS.find((weekday) => weekday.toLowerCase() === normalized);
  if (!day) throw new Error(`Invalid weekday: ${value}`);
  return day;
}

function findStoredMenu(menus, menuId) {
  const menu = menuId
    ? menus.find((item) => item.id === menuId)
    : [...menus].sort((a, b) => b.generated_at.localeCompare(a.generated_at))[0];
  if (!menu) throw new Error("No menu is available.");
  return menu;
}

async function validateManualMenuChange({
  candidate,
  menus,
  dishes,
  preferences
}) {
  const recentMenus = menus
    .filter((menu) => menu.week_start < candidate.week_start)
    .sort((a, b) => b.week_start.localeCompare(a.week_start));
  const errors = validateMenu(
    candidate,
    dishes,
    parsePreferences(preferences),
    candidate.week_start,
    recentMenus,
    { requiredDays: null }
  );
  if (errors.length) {
    throw new Error(`Menu change violates guardrails: ${errors.join("; ")}`);
  }
}

function reconcileTandooriPrep(days) {
  for (const entry of days) {
    entry.prep_notes = entry.prep_notes
      .split("\n")
      .filter(
        (line) =>
          !(
            /tandoori/i.test(line) &&
            /(marinat|overnight)/i.test(line)
          )
      )
      .join("\n")
      .trim();
  }
  const tandooriEntry = days.find(
    (entry) => entry.side_chicken === "Tandoori Chicken"
  );
  if (!tandooriEntry) return;
  tandooriEntry.prep_notes = [
    tandooriEntry.prep_notes,
    `Marinate Tandoori Chicken overnight before ${tandooriEntry.day}.`
  ].filter(Boolean).join("\n");
}

export async function swapMenuDays({ menuId, firstDay, secondDay }) {
  const first = canonicalWeekday(firstDay);
  const second = canonicalWeekday(secondDay);
  if (first === second) throw new Error("Choose two different menu days to swap.");
  return withStoreLock(async () => {
    const menusDb = db("menus");
    const dishesDb = db("dishes");
    const preferencesDb = db("preferences");
    await Promise.all([menusDb.read(), dishesDb.read(), preferencesDb.read()]);
    const storedMenu = findStoredMenu(menusDb.data.menus, menuId);
    const candidate = {
      week_start: storedMenu.week_start,
      days: structuredClone(storedMenu.days)
    };
    const firstEntry = candidate.days.find((entry) => entry.day === first);
    const secondEntry = candidate.days.find((entry) => entry.day === second);
    if (!firstEntry || !secondEntry) {
      throw new Error("Both weekdays must already be scheduled to swap them.");
    }
    const firstMeal = { ...firstEntry, day: second };
    const secondMeal = { ...secondEntry, day: first };
    Object.assign(firstEntry, secondMeal);
    Object.assign(secondEntry, firstMeal);
    reconcileTandooriPrep(candidate.days);
    await validateManualMenuChange({
      candidate,
      menus: menusDb.data.menus,
      dishes: dishesDb.data.dishes,
      preferences: preferencesDb.data.preferences
    });
    storedMenu.days = candidate.days;
    await menusDb.write();
    return structuredClone(storedMenu);
  });
}

export async function moveMenuDay({ menuId, fromDay, toDay }) {
  const from = canonicalWeekday(fromDay);
  const to = canonicalWeekday(toDay);
  if (from === to) throw new Error("The meal is already scheduled on that day.");
  return withStoreLock(async () => {
    const menusDb = db("menus");
    const dishesDb = db("dishes");
    const preferencesDb = db("preferences");
    await Promise.all([menusDb.read(), dishesDb.read(), preferencesDb.read()]);
    const storedMenu = findStoredMenu(menusDb.data.menus, menuId);
    const candidate = {
      week_start: storedMenu.week_start,
      days: structuredClone(storedMenu.days)
    };
    const entry = candidate.days.find((item) => item.day === from);
    if (!entry) throw new Error(`${from} is not currently scheduled.`);
    if (candidate.days.some((item) => item.day === to)) {
      throw new Error(
        `${to} is already scheduled; use swap_menu_days to exchange the meals.`
      );
    }
    entry.day = to;
    reconcileTandooriPrep(candidate.days);
    await validateManualMenuChange({
      candidate,
      menus: menusDb.data.menus,
      dishes: dishesDb.data.dishes,
      preferences: preferencesDb.data.preferences
    });
    storedMenu.days = candidate.days;
    await menusDb.write();
    return structuredClone(storedMenu);
  });
}

export async function getConversationHistory(limit = 10) {
  return withStoreLock(async () => {
    await db("conversations").read();
    return structuredClone(db("conversations").data.conversations.slice(-limit));
  });
}

export async function saveConversation(userMessage, assistantResponse, sender = null) {
  return withStoreLock(async () => {
    const conversationsDb = db("conversations");
    await conversationsDb.read();
    conversationsDb.data.conversations.push({
      id: randomUUID(),
      user_message: userMessage,
      assistant_response: assistantResponse,
      sender,
      timestamp: new Date().toISOString()
    });
    conversationsDb.data.conversations =
      conversationsDb.data.conversations.slice(-100);
    await conversationsDb.write();
  });
}

export async function recordMeal(args) {
  const input = MealRecordSchema.parse(args);
  return withStoreLock(async () => {
    const mealsDb = db("mealHistory");
    await mealsDb.read();
    const existing = mealsDb.data.meals.find(
      (meal) => meal.date === input.date && meal.scope === input.scope
    );
    const now = new Date().toISOString();
    if (existing) {
      const nextMain =
        input.main_dish !== undefined ? input.main_dish : existing.main_dish;
      const nextSide =
        input.side_chicken !== undefined
          ? input.side_chicken
          : existing.side_chicken;
      if (!nextMain && !nextSide) {
        throw new Error("A meal record needs at least one consumed dish.");
      }
      existing.main_dish = nextMain;
      existing.side_chicken = nextSide;
      if (input.notes !== undefined) existing.notes = input.notes;
      existing.source = input.source;
      existing.recorded_by = input.recordedBy;
      existing.updated_at = now;
      await mealsDb.write();
      return structuredClone(existing);
    }
    if (!input.main_dish && !input.side_chicken) {
      throw new Error("A new meal record needs at least one consumed dish.");
    }
    const meal = {
      id: randomUUID(),
      date: input.date,
      scope: input.scope,
      main_dish: input.main_dish ?? null,
      side_chicken: input.side_chicken ?? null,
      notes: input.notes ?? null,
      source: input.source,
      recorded_by: input.recordedBy,
      created_at: now,
      updated_at: now
    };
    mealsDb.data.meals.push(meal);
    mealsDb.data.meals = mealsDb.data.meals.slice(-1000);
    await mealsDb.write();
    return structuredClone(meal);
  });
}

export async function getMealHistory(args) {
  const input = MealHistoryQuerySchema.parse(args);
  return withStoreLock(async () => {
    const mealsDb = db("mealHistory");
    await mealsDb.read();
    return structuredClone(
      mealsDb.data.meals
        .filter((meal) => input.scopes.includes(meal.scope))
        .sort(
          (a, b) =>
            b.date.localeCompare(a.date) ||
            b.updated_at.localeCompare(a.updated_at)
        )
        .slice(0, input.limit)
    );
  });
}

export async function forgetMeal(id, allowedScopes) {
  const mealId = z.string().uuid().parse(id);
  const scopes = z.array(
    z.string().regex(/^(household|person:[A-Za-z0-9_-]{1,100})$/)
  ).min(1).parse(allowedScopes);
  return withStoreLock(async () => {
    const mealsDb = db("mealHistory");
    await mealsDb.read();
    const index = mealsDb.data.meals.findIndex(
      (meal) => meal.id === mealId && scopes.includes(meal.scope)
    );
    if (index < 0) throw new Error("Meal not found in an accessible scope.");
    const [removed] = mealsDb.data.meals.splice(index, 1);
    await mealsDb.write();
    return structuredClone(removed);
  });
}

function memorySearchScore(content, query) {
  const normalizedContent = content.toLowerCase();
  const normalizedQuery = query.toLowerCase().trim();
  if (!normalizedQuery) return 0;
  const tokens = [...new Set(normalizedQuery.match(/[\p{L}\p{N}]+/gu) ?? [])]
    .filter((token) => token.length >= 2);
  let score = normalizedContent.includes(normalizedQuery) ? 10 : 0;
  for (const token of tokens) {
    if (normalizedContent.includes(token)) score += 1;
  }
  return score;
}

export async function rememberContext(args) {
  const input = MemoryInputSchema.parse(args);
  return withStoreLock(async () => {
    const memoriesDb = db("memories");
    await memoriesDb.read();
    const normalized = input.content.toLowerCase();
    const existing = memoriesDb.data.memories.find(
      (memory) =>
        memory.scope === input.scope &&
        memory.content.trim().toLowerCase() === normalized
    );
    const now = new Date().toISOString();
    if (existing) {
      existing.updated_at = now;
      existing.source = input.source;
      existing.created_by = input.createdBy;
      await memoriesDb.write();
      return structuredClone(existing);
    }
    const memory = {
      id: randomUUID(),
      scope: input.scope,
      content: input.content,
      source: input.source,
      created_by: input.createdBy,
      created_at: now,
      updated_at: now
    };
    memoriesDb.data.memories.push(memory);
    memoriesDb.data.memories = memoriesDb.data.memories.slice(-500);
    await memoriesDb.write();
    return structuredClone(memory);
  });
}

export async function searchContext(args) {
  const input = MemorySearchSchema.parse(args);
  return withStoreLock(async () => {
    const memoriesDb = db("memories");
    await memoriesDb.read();
    return structuredClone(
      memoriesDb.data.memories
        .filter((memory) => input.scopes.includes(memory.scope))
        .map((memory) => ({
          memory,
          score: memorySearchScore(memory.content, input.query)
        }))
        .sort(
          (a, b) =>
            b.score - a.score ||
            b.memory.updated_at.localeCompare(a.memory.updated_at)
        )
        .slice(0, input.limit)
        .map(({ memory }) => memory)
    );
  });
}

export async function forgetContext(id, allowedScopes) {
  const memoryId = z.string().uuid().parse(id);
  const scopes = z.array(
    z.string().regex(/^(household|person:[A-Za-z0-9_-]{1,100})$/)
  ).min(1).parse(allowedScopes);
  return withStoreLock(async () => {
    const memoriesDb = db("memories");
    await memoriesDb.read();
    const index = memoriesDb.data.memories.findIndex(
      (memory) => memory.id === memoryId && scopes.includes(memory.scope)
    );
    if (index < 0) throw new Error("Memory not found in an accessible scope.");
    const [removed] = memoriesDb.data.memories.splice(index, 1);
    await memoriesDb.write();
    return structuredClone(removed);
  });
}

export function getDataFiles() {
  return { ...files };
}
