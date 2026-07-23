export function validateRuntimeConfig(env = process.env) {
  const errors = [];
  const production = env.NODE_ENV === "production";

  for (const key of ["API_BEARER_TOKEN", "MCP_BEARER_TOKEN"]) {
    if (!env[key]) errors.push(`${key} is required`);
    else if (production && env[key].length < 32) {
      errors.push(`${key} must be at least 32 characters in production`);
    }
  }

  if (production) {
    for (const key of [
      "OPENAI_API_KEY",
      "TELEGRAM_BOT_TOKEN",
      "TELEGRAM_CHAT_ID",
      "OPENAI_MENU_MODEL",
      "OPENAI_AGENT_MODEL"
    ]) {
      if (!env[key]) errors.push(`${key} is required in production`);
    }
  }

  if (env.TELEGRAM_CHAT_ID && !/^-?\d+$/.test(env.TELEGRAM_CHAT_ID)) {
    errors.push("TELEGRAM_CHAT_ID must be numeric");
  }
  if (
    env.TELEGRAM_ALLOWED_USER_IDS &&
    !env.TELEGRAM_ALLOWED_USER_IDS
      .split(",")
      .map((value) => value.trim())
      .every((value) => /^\d+$/.test(value))
  ) {
    errors.push("TELEGRAM_ALLOWED_USER_IDS must be a comma-separated list of numeric IDs");
  }
  if (env.PORT && (!Number.isInteger(Number(env.PORT)) || Number(env.PORT) <= 0)) {
    errors.push("PORT must be a positive integer");
  }
  try {
    new Intl.DateTimeFormat("en-US", {
      timeZone: env.TZ || "Asia/Kolkata"
    }).format(new Date());
  } catch {
    errors.push(`Invalid TZ value: ${env.TZ}`);
  }

  if (errors.length) {
    throw new Error(`Invalid configuration:\n- ${errors.join("\n- ")}`);
  }
}
