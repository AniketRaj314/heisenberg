import "dotenv/config";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
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
    "Content-Security-Policy":
      "default-src 'self'; img-src 'self' data:; style-src 'self'; " +
      "script-src 'self'; connect-src 'self'; base-uri 'none'; " +
      "frame-ancestors 'none'; form-action 'none'",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer"
  });
  next();
});
app.use(express.static(path.join(__dirname, "public"), {
  index: false,
  maxAge: process.env.NODE_ENV === "production" ? "1h" : 0
}));
app.get("/", (_request, response) =>
  response.sendFile(path.join(__dirname, "public", "index.html"))
);
app.get("/health", (_request, response) => response.json({ status: "ok" }));
mountMcpServer(app);
app.use("/api", requireBearerToken(apiBearerToken, "heisenberg-api"));
app.get("/api", (_request, response) => {
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
