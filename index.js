import "dotenv/config";
import express from "express";
import { requireBearerToken } from "./src/auth/bearer.js";
import { validateRuntimeConfig } from "./src/config.js";
import { initStore } from "./src/db/store.js";
import { seedStore } from "./src/db/seed.js";
import { mountMcpServer } from "./src/mcp/server.js";
import { startScheduler } from "./src/scheduler/cron.js";
import { startTelegramBot, stopTelegramBot } from "./src/telegram/bot.js";

validateRuntimeConfig();
await initStore();
await seedStore();

const apiBearerToken = process.env.API_BEARER_TOKEN;
if (!apiBearerToken) {
  throw new Error("API_BEARER_TOKEN is required; refusing to start an unauthenticated API.");
}

const app = express();
app.set("trust proxy", 1);
app.disable("x-powered-by");
app.use((_request, response, next) => {
  response.set({
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer"
  });
  next();
});
app.get("/health", (_request, response) => response.json({ status: "ok" }));
mountMcpServer(app);
app.use(requireBearerToken(apiBearerToken, "heisenberg-api"));
app.get("/", (_request, response) => {
  response.json({
    name: "Heisenberg",
    status: "ok",
    message: "The cook is in."
  });
});

const port = Number(process.env.PORT || 3000);
const httpServer = app.listen(port, () => {
  console.log(`Heisenberg API and MCP server listening on port ${port}.`);
});

await startTelegramBot();
const cronTask = await startScheduler();

async function shutdown(signal) {
  console.log(`Received ${signal}; shutting down.`);
  cronTask.stop();
  stopTelegramBot(signal);
  httpServer.close();
}

process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));
