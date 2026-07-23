import {
  addDish,
  confirmMenu,
  disableDish,
  forgetContext,
  getDishes,
  getMenus,
  getPreferences,
  getRelevantMenu,
  modifyMenuDay,
  rememberContext,
  searchContext,
  updateDish,
  updatePreference
} from "../db/store.js";
import { generateMenu, getMonday } from "../scheduler/generator.js";

export const toolDefinitions = [
  { name: "get_current_menu", description: "Get this week's confirmed or active menu.", parameters: { type: "object", properties: {} } },
  { name: "get_dish_list", description: "Get all dishes.", parameters: { type: "object", properties: {} } },
  {
    name: "add_dish",
    description: "Add a dish to the master list.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string" },
        category: { type: "string", enum: ["carb_heavy", "chicken_main", "paneer_main", "sabzi", "dry_chicken"] },
        tags: { type: "array", items: { type: "string" } }
      },
      required: ["name", "category"]
    }
  },
  {
    name: "disable_dish",
    description: "Disable a dish by name or id.",
    parameters: {
      type: "object",
      properties: { name_or_id: { type: "string" } },
      required: ["name_or_id"]
    }
  },
  {
    name: "update_dish",
    description:
      "Update any mutable part of an existing dish: rename it, recategorise it, " +
      "replace its tags, or enable/disable it.",
    parameters: {
      type: "object",
      properties: {
        name_or_id: { type: "string" },
        name: { type: "string" },
        category: { type: "string", enum: ["carb_heavy", "chicken_main", "paneer_main", "sabzi", "dry_chicken"] },
        tags: { type: "array", items: { type: "string" } },
        active: { type: "boolean" }
      },
      required: ["name_or_id"]
    }
  },
  {
    name: "update_preference",
    description:
      "Update a meal-planning preference. custom_rules entries must use one of: " +
      "never:<term>, max_category:<category>:<0-5>, require_main:<dish>, " +
      "not_on:<day>:<dish>, pair:<dish>|<dish>.",
    parameters: {
      type: "object",
      properties: { key: { type: "string" }, value: {} },
      required: ["key", "value"]
    }
  },
  { name: "get_preferences", description: "Get all preferences.", parameters: { type: "object", properties: {} } },
  {
    name: "regenerate_menu",
    description: "Generate a fresh menu for next week.",
    parameters: { type: "object", properties: {} }
  },
  {
    name: "confirm_menu",
    description: "Confirm the newest draft menu and make it active.",
    parameters: {
      type: "object",
      properties: { menu_id: { type: "string" } }
    }
  },
  {
    name: "modify_menu_day",
    description: "Modify fields for a day in the latest menu.",
    parameters: {
      type: "object",
      properties: {
        menu_id: { type: "string" },
        day: { type: "string" },
        main_dish: { type: "string" },
        side_chicken: { type: ["string", "null"] },
        prep_notes: { type: "string" },
        cook_notes: { type: "string" }
      },
      required: ["day"]
    }
  },
  {
    name: "get_menu_history",
    description: "Get past menus.",
    parameters: {
      type: "object",
      properties: { weeks: { type: "integer", minimum: 1, maximum: 52 } }
    }
  },
  {
    name: "remember_context",
    description:
      "Save a durable free-form fact, soft preference, routine, or household decision. " +
      "Use personal scope for the current speaker and household for genuinely shared context. " +
      "Never store credentials, tokens, or transient requests.",
    parameters: {
      type: "object",
      properties: {
        scope: { type: "string", enum: ["personal", "household"] },
        content: { type: "string", minLength: 1, maxLength: 2000 }
      },
      required: ["scope", "content"]
    }
  },
  {
    name: "search_context",
    description:
      "Search durable memories accessible to the current speaker. Use all to search " +
      "their personal memories and shared household memories.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string" },
        scope: { type: "string", enum: ["personal", "household", "all"] },
        limit: { type: "integer", minimum: 1, maximum: 20 }
      }
    }
  },
  {
    name: "forget_context",
    description:
      "Delete a durable memory by id when the current speaker asks to forget or correct it.",
    parameters: {
      type: "object",
      properties: { memory_id: { type: "string" } },
      required: ["memory_id"]
    }
  }
];

function personalMemoryScope(context) {
  const id = context.actor?.telegram_user_id;
  if (!id || id === "unknown") {
    throw new Error("A known Telegram sender is required for personal memory.");
  }
  return `person:${id}`;
}

function accessibleMemoryScopes(context) {
  const scopes = ["household"];
  const id = context.actor?.telegram_user_id;
  if (id && id !== "unknown") scopes.push(`person:${id}`);
  return scopes;
}

export async function executeTool(name, args = {}, context = {}) {
  switch (name) {
    case "get_current_menu": {
      const weekStart = getMonday(-1);
      return getRelevantMenu(weekStart);
    }
    case "get_dish_list":
      return getDishes();
    case "add_dish":
      return addDish(args);
    case "disable_dish":
      return disableDish(args.name_or_id);
    case "update_dish":
      return updateDish(args);
    case "update_preference":
      return updatePreference(args.key, args.value);
    case "get_preferences":
      return getPreferences();
    case "regenerate_menu":
      return generateMenu();
    case "confirm_menu":
      return confirmMenu(args.menu_id);
    case "modify_menu_day":
      return modifyMenuDay({
        menuId: args.menu_id,
        day: args.day,
        main_dish: args.main_dish,
        side_chicken: args.side_chicken,
        prep_notes: args.prep_notes,
        cook_notes: args.cook_notes
      });
    case "get_menu_history": {
      const menus = await getMenus();
      return menus
        .sort((a, b) => b.week_start.localeCompare(a.week_start))
        .slice(0, args.weeks ?? 4);
    }
    case "remember_context": {
      if (!["personal", "household"].includes(args.scope)) {
        throw new Error("Memory scope must be personal or household.");
      }
      const scope =
        args.scope === "household" ? "household" : personalMemoryScope(context);
      return rememberContext({
        scope,
        content: args.content,
        source: context.source ?? "agent",
        createdBy: context.actor?.telegram_user_id ?? null
      });
    }
    case "search_context": {
      if (
        args.scope !== undefined &&
        !["personal", "household", "all"].includes(args.scope)
      ) {
        throw new Error("Memory search scope must be personal, household, or all.");
      }
      const allScopes = accessibleMemoryScopes(context);
      const scopes =
        args.scope === "household"
          ? ["household"]
          : args.scope === "personal"
            ? [personalMemoryScope(context)]
            : allScopes;
      return searchContext({
        scopes,
        query: args.query ?? "",
        limit: args.limit ?? 10
      });
    }
    case "forget_context":
      return forgetContext(args.memory_id, accessibleMemoryScopes(context));
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
