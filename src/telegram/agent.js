import OpenAI from "openai";
import {
  getConversationHistory,
  getPreferences,
  searchContext,
  saveConversation
} from "../db/store.js";
import { AGENT_SYSTEM_PROMPT } from "../prompts/agent_system.js";
import { executeTool, toolDefinitions } from "../mcp/tools.js";

export function buildMenuFacts(menu, dishes) {
  const activeDishes = dishes.filter((dish) => dish.active);
  const chickenMains = activeDishes
    .filter((dish) => dish.category === "chicken_main")
    .map((dish) => dish.name);
  const dryChickenSides = activeDishes
    .filter((dish) => dish.category === "dry_chicken")
    .map((dish) => dish.name);
  const nonChickenMains = activeDishes
    .filter((dish) =>
      ["carb_heavy", "paneer_main", "sabzi"].includes(dish.category)
    )
    .map((dish) => dish.name);
  const compositionFacts = {
    meal_composition_rule:
      "A meal has exactly one substantial main dish from the master list. " +
      "A chicken_main is a complete standalone main and must not be paired with " +
      "another master-list dish. A non-chicken main may be paired only with one " +
      "active dry_chicken dish. dry_chicken dishes are sides only and never mains.",
    chicken_main_dishes: chickenMains,
    non_chicken_main_dishes: nonChickenMains,
    valid_catalogued_side_dishes: dryChickenSides,
    light_accompaniments:
      "Small uncatalogued accompaniments such as salad, raita, or plain curd are " +
      "fine, but they are not a second main dish."
  };
  if (!menu) return { menu_available: false, ...compositionFacts };
  const scheduledDayNames = ["Monday", "Tuesday", "Thursday", "Friday", "Saturday"];
  const scheduledDays = scheduledDayNames.map((day) =>
    menu.days.find((entry) => entry.day === day)
  );
  const activeDrySides = dryChickenSides;
  const usedDrySides = menu.days
    .map((entry) => entry.side_chicken)
    .filter(Boolean);
  const uncoveredEligibleDays = menu.days
    .filter((entry) => entry.slot_type !== "chicken_main" && !entry.side_chicken)
    .map((entry) => entry.day);
  const validSidesForUncoveredDays = Object.fromEntries(
    uncoveredEligibleDays.map((day) => {
      const index = scheduledDayNames.indexOf(day);
      const previousSide = scheduledDays[index - 1]?.side_chicken;
      const nextSide = scheduledDays[index + 1]?.side_chicken;
      return [
        day,
        activeDrySides.filter(
          (name) =>
            name !== previousSide &&
            name !== nextSide &&
            !(day === "Monday" && name === "Tandoori Chicken")
        )
      ];
    })
  );
  return {
    menu_available: true,
    ...compositionFacts,
    side_allocation_rule:
      "Chicken-main days have no catalogued side. Every other day should have one " +
      "active dry-chicken side. A side may repeat during the week, but not on " +
      "consecutive scheduled meal days.",
    active_dry_chicken_sides: activeDrySides,
    used_dry_chicken_sides: usedDrySides,
    eligible_days_without_a_side: uncoveredEligibleDays,
    valid_sides_for_uncovered_days: validSidesForUncoveredDays
  };
}

function cleanIdentityField(value, maxLength = 100) {
  const cleaned = String(value ?? "").trim();
  return cleaned ? cleaned.slice(0, maxLength) : null;
}

export function normalizeTelegramSender(sender = {}) {
  const firstName = cleanIdentityField(sender.first_name);
  const lastName = cleanIdentityField(sender.last_name);
  const username = cleanIdentityField(sender.username);
  const displayName =
    [firstName, lastName].filter(Boolean).join(" ") ||
    (username ? `@${username}` : null) ||
    "Unknown Telegram user";
  return {
    telegram_user_id: cleanIdentityField(sender.id, 30) ?? "unknown",
    display_name: displayName,
    username
  };
}

function historyUserContent(item) {
  const sender = item.sender ?? {
    telegram_user_id: "unknown",
    display_name: "Unknown sender (legacy conversation)",
    username: null
  };
  return `SENDER:\n${JSON.stringify(sender)}\n\nMESSAGE:\n${item.user_message}`;
}

export async function runAgent(userMessage, telegramSender = {}) {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is required for conversational messages.");
  }
  const currentSender = normalizeTelegramSender(telegramSender);
  const memoryScopes = ["household"];
  if (currentSender.telegram_user_id !== "unknown") {
    memoryScopes.push(`person:${currentSender.telegram_user_id}`);
  }
  const [history, currentMenu, preferences, dishes, relevantMemories] = await Promise.all([
    getConversationHistory(10),
    executeTool("get_current_menu"),
    getPreferences(),
    executeTool("get_dish_list"),
    searchContext({
      scopes: memoryScopes,
      query: userMessage,
      limit: 12
    })
  ]);
  const client = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
    timeout: 60_000,
    maxRetries: 2
  });
  const menuFacts = buildMenuFacts(currentMenu, dishes);
  const messages = [
    {
      role: "system",
      content:
        `${AGENT_SYSTEM_PROMPT}` +
        `\n\nCURRENT MENU:\n${JSON.stringify(currentMenu)}` +
        `\n\nPREFERENCES:\n${JSON.stringify(preferences)}` +
        `\n\nMASTER DISH LIST:\n${JSON.stringify(dishes)}` +
        `\n\nDETERMINISTIC MENU FACTS:\n${JSON.stringify(menuFacts)}` +
        `\n\nCURRENT SENDER:\n${JSON.stringify(currentSender)}` +
        `\n\nRELEVANT DURABLE MEMORIES:\n${JSON.stringify(relevantMemories)}`
    },
    ...history.flatMap((item) => [
      { role: "user", content: historyUserContent(item) },
      { role: "assistant", content: item.assistant_response }
    ]),
    {
      role: "user",
      content: `SENDER:\n${JSON.stringify(currentSender)}\n\nMESSAGE:\n${userMessage}`
    }
  ];
  const tools = toolDefinitions.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters
    }
  }));

  let answer = "";
  for (let turn = 0; turn < 6; turn += 1) {
    const completion = await client.chat.completions.create({
      model:
        process.env.OPENAI_AGENT_MODEL ||
        process.env.OPENAI_MODEL ||
        "gpt-5.6-terra",
      messages,
      tools,
      tool_choice: "auto",
      reasoning_effort: "none",
      max_completion_tokens: 1800
    });
    const message = completion.choices[0]?.message;
    if (!message) throw new Error("The AI returned no response.");
    messages.push(message);
    if (!message.tool_calls?.length) {
      answer = message.content || "Done.";
      break;
    }
    for (const call of message.tool_calls) {
      try {
        const result = await executeTool(
          call.function.name,
          JSON.parse(call.function.arguments || "{}"),
          { actor: currentSender, source: "telegram-agent" }
        );
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: JSON.stringify({ ok: true, result })
        });
      } catch (error) {
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: JSON.stringify({ ok: false, error: error.message })
        });
      }
    }
  }
  if (!answer) throw new Error("The agent exceeded its tool-call limit.");
  await saveConversation(userMessage, answer, currentSender);
  return answer;
}
