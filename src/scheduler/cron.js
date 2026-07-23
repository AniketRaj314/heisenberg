import cron from "node-cron";
import { getMenuForWeek } from "../db/store.js";
import { generateMenu, getMonday, getTimeZone } from "./generator.js";
import { sendMenuToTelegram } from "../telegram/bot.js";

function zonedDayAndHour(date, timeZone) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      weekday: "short",
      hour: "2-digit",
      hourCycle: "h23"
    })
      .formatToParts(date)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value])
  );
  return { weekday: parts.weekday, hour: Number(parts.hour) };
}

export function getCatchUpWeekStart(now = new Date(), timeZone = getTimeZone()) {
  const { weekday, hour } = zonedDayAndHour(now, timeZone);
  if (weekday === "Fri" && hour < 18) return null;
  if (["Fri", "Sat", "Sun"].includes(weekday)) return getMonday(0, now);
  if (["Wed", "Thu"].includes(weekday)) return null;
  return getMonday(-1, now);
}

async function catchUpMissedGeneration() {
  const weekStart = getCatchUpWeekStart();
  if (!weekStart || (await getMenuForWeek(weekStart))) return null;
  console.log(`No menu found for ${weekStart}; running scheduler catch-up.`);
  return generateMenu({
    weekStart,
    scheduled: true,
    notify: sendMenuToTelegram
  });
}

export async function startScheduler() {
  try {
    await catchUpMissedGeneration();
  } catch (error) {
    console.error("Menu generation catch-up failed:", error);
  }

  const timeZone = getTimeZone();
  const task = cron.schedule(
    "0 18 * * 5",
    async () => {
      try {
        const weekStart = getMonday();
        if (await getMenuForWeek(weekStart)) {
          console.log(`Menu for ${weekStart} already exists; scheduled generation skipped.`);
          return;
        }
        const menu = await generateMenu({ weekStart, scheduled: true });
        await sendMenuToTelegram(menu);
      } catch (error) {
        console.error("Scheduled menu generation failed:", error);
      }
    },
    { timezone: timeZone }
  );
  console.log(`Scheduler started: Fridays at 18:00 ${timeZone}.`);
  return task;
}
