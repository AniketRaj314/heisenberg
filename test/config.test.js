import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { validateRuntimeConfig } from "../src/config.js";

test("Railway configuration uses release-safe settings", async () => {
  const config = await readFile(new URL("../railway.toml", import.meta.url), "utf8");
  assert.match(config, /builder = "RAILPACK"/);
  assert.match(config, /healthcheckPath = "\/health"/);
  assert.match(config, /numReplicas = 1/);
  assert.match(config, /restartPolicyType = "ON_FAILURE"/);
  assert.doesNotMatch(config, /\[\[services\]\]/);
});

test("secret and runtime data files are excluded from Git", async () => {
  const gitignore = await readFile(new URL("../.gitignore", import.meta.url), "utf8");
  assert.match(gitignore, /^\.env$/m);
  assert.match(gitignore, /^src\/data\/\*\.json$/m);
});

test("production configuration fails closed on missing integrations and weak secrets", () => {
  assert.throws(() =>
    validateRuntimeConfig({
      NODE_ENV: "production",
      API_BEARER_TOKEN: "short",
      MCP_BEARER_TOKEN: "short",
      TZ: "Not/AZone"
    })
  );
  assert.doesNotThrow(() =>
    validateRuntimeConfig({
      NODE_ENV: "production",
      API_BEARER_TOKEN: "a".repeat(32),
      MCP_BEARER_TOKEN: "b".repeat(32),
      OPENAI_API_KEY: "configured",
      TELEGRAM_BOT_TOKEN: "configured",
      TELEGRAM_CHAT_ID: "-100123",
      OPENAI_MENU_MODEL: "menu-model",
      OPENAI_AGENT_MODEL: "agent-model",
      TZ: "Asia/Kolkata"
    })
  );
});
