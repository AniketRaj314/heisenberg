import { Input, Telegraf } from "telegraf";
import {
  confirmMenu,
  getDataFiles,
  getDishes,
  getRelevantMenu
} from "../db/store.js";
import { generateMenu, getMonday } from "../scheduler/generator.js";
import { runAgent } from "./agent.js";
import { formatAgentResponse, formatDishes, formatMenu } from "./format.js";
import { createRateLimiter } from "../security/rateLimit.js";

let bot;
const messageLimiter = createRateLimiter({ limit: 20, windowMs: 5 * 60_000 });

function allowedUser(ctx) {
  const configured = (process.env.TELEGRAM_ALLOWED_USER_IDS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  return !configured.length || configured.includes(String(ctx.from?.id));
}

function allowedChat(ctx) {
  return (
    String(ctx.chat?.id) === String(process.env.TELEGRAM_CHAT_ID) &&
    allowedUser(ctx)
  );
}

function linkedReplyOptions(ctx, options = {}) {
  const messageId = ctx.message?.message_id;
  if (!messageId) return options;
  return {
    ...options,
    reply_parameters: {
      allow_sending_without_reply: true,
      ...options.reply_parameters,
      message_id: messageId
    }
  };
}

async function replyToMessage(ctx, text, options = {}) {
  return ctx.reply(text, linkedReplyOptions(ctx, options));
}

async function sendLongMessage(ctx, text, options = {}) {
  const chunks = text.match(/[\s\S]{1,3900}/g) ?? [text];
  for (const chunk of chunks) await replyToMessage(ctx, chunk, options);
}

async function sendAgentResponse(ctx, text) {
  const chunks = text.match(/[\s\S]{1,3400}(?=\n|$)|[\s\S]{1,3400}/g) ?? [text];
  for (const chunk of chunks) {
    await replyToMessage(ctx, formatAgentResponse(chunk), { parse_mode: "HTML" });
  }
}

export function shouldRespondToMessage(message, botInfo) {
  const text = message?.text ?? "";
  if (text.startsWith("/")) return true;
  if (message?.reply_to_message?.from?.id === botInfo?.id) return true;
  const username = botInfo?.username?.toLowerCase();
  return (message?.entities ?? []).some((entity) => {
    if (entity.type === "text_mention") return entity.user?.id === botInfo?.id;
    if (entity.type !== "mention" || !username) return false;
    return text
      .slice(entity.offset, entity.offset + entity.length)
      .toLowerCase() === `@${username}`;
  });
}

function removeBotMention(text, username) {
  if (!username) return text.trim();
  const escaped = username.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return text.replace(new RegExp(`@${escaped}`, "gi"), "").trim();
}

export function getTelegramBot() {
  return bot;
}

export async function sendMenuToTelegram(menu) {
  if (!bot || !process.env.TELEGRAM_CHAT_ID) return;
  await bot.telegram.sendMessage(process.env.TELEGRAM_CHAT_ID, formatMenu(menu), {
    parse_mode: "Markdown"
  });
}

export async function startTelegramBot() {
  if (!process.env.TELEGRAM_BOT_TOKEN || !process.env.TELEGRAM_CHAT_ID) {
    console.warn("Telegram is disabled: TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID is missing.");
    return null;
  }

  bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);
  bot.use(async (ctx, next) => {
    if (!allowedChat(ctx)) return;
    return next();
  });

  bot.command("menu", async (ctx) => {
    const menu = await getRelevantMenu(getMonday(-1));
    await sendLongMessage(ctx, formatMenu(menu), { parse_mode: "Markdown" });
  });

  bot.command("generate", async (ctx) => {
    await replyToMessage(ctx, "Cooking up next week's draft…");
    const menu = await generateMenu();
    await sendLongMessage(ctx, formatMenu(menu), { parse_mode: "Markdown" });
    await replyToMessage(ctx, "Reply with changes, or use /confirm when it looks right.");
  });

  bot.command("confirm", async (ctx) => {
    const menu = await confirmMenu();
    await replyToMessage(ctx, `✅ Menu for ${menu.week_start} is now active.`);
  });

  bot.command("dishes", async (ctx) => {
    await sendLongMessage(ctx, formatDishes(await getDishes()), {
      parse_mode: "Markdown"
    });
  });

  bot.command("backup", async (ctx) => {
    const files = getDataFiles();
    for (const name of ["dishes", "menus", "preferences"]) {
      await ctx.replyWithDocument(Input.fromLocalFile(files[name]), {
        ...linkedReplyOptions(ctx),
        caption: `${name}.json`
      });
    }
  });

  bot.command("help", async (ctx) => {
    await replyToMessage(
      ctx,
      [
        "Heisenberg commands:",
        "/menu — show the current menu",
        "/generate — generate next week's draft",
        "/confirm — make the newest draft active",
        "/dishes — list all dishes by category",
        "/backup — download the important JSON data files",
        "/help — show this help",
        "",
        "You can also message me naturally to change menus, dishes, or preferences."
      ].join("\n")
    );
  });

  bot.on("text", async (ctx) => {
    if (ctx.message.text.startsWith("/")) return;
    if (!shouldRespondToMessage(ctx.message, ctx.botInfo)) return;
    const rate = messageLimiter.consume(String(ctx.from?.id ?? ctx.chat.id));
    if (!rate.allowed) {
      const minutes = Math.max(1, Math.ceil(rate.retryAfterMs / 60_000));
      await replyToMessage(
        ctx,
        `Slow down, chef — try again in about ${minutes} minute(s).`
      );
      return;
    }
    await ctx.sendChatAction("typing");
    const userMessage =
      removeBotMention(ctx.message.text, ctx.botInfo?.username) || "Hello";
    const response = await runAgent(userMessage, ctx.from);
    await sendAgentResponse(ctx, response);
  });

  bot.catch(async (error, ctx) => {
    console.error("Telegram update failed:", error);
    if (ctx?.chat) {
      await replyToMessage(
        ctx,
        "I hit an internal error. Please try again shortly."
      ).catch(() => {});
    }
  });

  await bot.launch();
  console.log("Heisenberg Telegram bot started.");
  return bot;
}

export function stopTelegramBot(signal) {
  if (bot) bot.stop(signal);
}
