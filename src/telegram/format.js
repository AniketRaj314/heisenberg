import { WEEKDAYS } from "../domain/menu.js";

export function formatMenu(menu) {
  if (!menu) return "No menu is available yet.";
  const lines = [
    `🍽 Heisenberg menu — week of ${menu.week_start}`,
    `Status: ${menu.status}`,
    ""
  ];
  const scheduledDays = [...menu.days].sort(
    (a, b) => WEEKDAYS.indexOf(a.day) - WEEKDAYS.indexOf(b.day)
  );
  for (const entry of scheduledDays) {
    const mealStatus = entry.meal_status ?? "planned";
    if (mealStatus !== "planned") {
      lines.push(`*${entry.day}* · ${mealStatus.replaceAll("_", " ")}`);
      if (entry.prep_notes) lines.push(`Note: ${entry.prep_notes}`);
      if (entry.cook_notes) lines.push(`Note: ${entry.cook_notes}`);
      lines.push("");
      continue;
    }
    lines.push(`*${entry.day}* · ${entry.slot_type.replaceAll("_", " ")}`);
    lines.push(`Main: ${entry.main_dish}`);
    if (entry.side_chicken) lines.push(`Side: ${entry.side_chicken}`);
    if (entry.prep_notes) lines.push(`Prep: ${entry.prep_notes}`);
    if (entry.cook_notes) lines.push(`Cook: ${entry.cook_notes}`);
    lines.push("");
  }
  return lines.join("\n").trim();
}

export function formatDishes(dishes) {
  const grouped = dishes.reduce((result, dish) => {
    (result[dish.category] ??= []).push(dish);
    return result;
  }, {});
  return Object.entries(grouped)
    .map(([category, items]) => {
      const names = items.map((dish) => `${dish.active ? "•" : "◦"} ${dish.name}`).join("\n");
      return `*${category.replaceAll("_", " ")}*\n${names}`;
    })
    .join("\n\n");
}

function escapeHtml(text) {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

export function formatAgentResponse(text) {
  return escapeHtml(text)
    .replace(/```(?:\w+)?\n?([\s\S]*?)```/g, "<pre>$1</pre>")
    .replace(/`([^`\n]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>")
    .replace(/__([^_\n]+)__/g, "<b>$1</b>")
    .replace(/~~([^~\n]+)~~/g, "<s>$1</s>")
    .replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, "<i>$1</i>");
}
