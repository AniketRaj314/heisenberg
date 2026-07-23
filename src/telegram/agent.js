import OpenAI from "openai";
import {
  getConversationHistory,
  getPreferences,
  saveConversation
} from "../db/store.js";
import { AGENT_SYSTEM_PROMPT } from "../prompts/agent_system.js";
import { executeTool, toolDefinitions } from "../mcp/tools.js";

export function buildMenuFacts(menu, dishes) {
  if (!menu) return { menu_available: false };
  const scheduledDayNames = ["Monday", "Tuesday", "Thursday", "Friday", "Saturday"];
  const scheduledDays = scheduledDayNames.map((day) =>
    menu.days.find((entry) => entry.day === day)
  );
  const activeDrySides = dishes
    .filter((dish) => dish.active && dish.category === "dry_chicken")
    .map((dish) => dish.name);
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
    side_allocation_rule:
      "Chicken-main days must not have a chicken side. Every other day should have an active dry-chicken side. A side may repeat during the week, but not on consecutive scheduled meal days.",
    active_dry_chicken_sides: activeDrySides,
    used_dry_chicken_sides: usedDrySides,
    eligible_days_without_a_side: uncoveredEligibleDays,
    valid_sides_for_uncovered_days: validSidesForUncoveredDays
  };
}

export async function runAgent(userMessage) {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is required for conversational messages.");
  }
  const [history, currentMenu, preferences, dishes] = await Promise.all([
    getConversationHistory(10),
    executeTool("get_current_menu"),
    getPreferences(),
    executeTool("get_dish_list")
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
        `\n\nDETERMINISTIC MENU FACTS:\n${JSON.stringify(menuFacts)}`
    },
    ...history.flatMap((item) => [
      { role: "user", content: item.user_message },
      { role: "assistant", content: item.assistant_response }
    ]),
    { role: "user", content: userMessage }
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
          JSON.parse(call.function.arguments || "{}")
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
  await saveConversation(userMessage, answer);
  return answer;
}
