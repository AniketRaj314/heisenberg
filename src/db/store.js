import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { JSONFilePreset } from "lowdb/node";
import { z } from "zod";
import { parseMenuDraft, validateMenu } from "../domain/menu.js";
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
  conversations: path.join(DATA_DIR, "conversations.json")
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
  conversations: { conversations: [] }
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
      recentMenus
    );
    if (errors.length) {
      throw new Error(`Menu change violates guardrails: ${errors.join("; ")}`);
    }

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

export function getDataFiles() {
  return { ...files };
}
