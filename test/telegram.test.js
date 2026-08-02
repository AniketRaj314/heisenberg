import test from "node:test";
import assert from "node:assert/strict";
import {
  buildMenuFacts,
  normalizeTelegramSender,
  resolveAgentAnswer,
  resolveAgentReasoningEffort,
  summarizeToolAction
} from "../src/telegram/agent.js";
import {
  launchTelegramBotInBackground,
  shouldRespondToMessage
} from "../src/telegram/bot.js";
import { formatAgentResponse, formatMenu } from "../src/telegram/format.js";
import { AGENT_SYSTEM_PROMPT } from "../src/prompts/agent_system.js";
import { toolDefinitions } from "../src/mcp/tools.js";

test("agent Markdown is converted to safe Telegram HTML", () => {
  assert.equal(
    formatAgentResponse("Saturday is **Egg Curry** with `no side` & salad."),
    "Saturday is <b>Egg Curry</b> with <code>no side</code> &amp; salad."
  );
  assert.equal(
    formatAgentResponse("<script>alert('x')</script>"),
    "&lt;script&gt;alert('x')&lt;/script&gt;"
  );
});

test("menus render dining-out and skipped days without fake dishes", () => {
  const rendered = formatMenu({
    week_start: "2026-08-03",
    status: "draft",
    days: [
      {
        day: "Wednesday",
        meal_status: "dining_out",
        slot_type: null,
        main_dish: null,
        side_chicken: null,
        prep_notes: "",
        cook_notes: "Dinner with friends"
      },
      {
        day: "Thursday",
        meal_status: "planned",
        slot_type: "sabzi",
        main_dish: "Egg Curry",
        side_chicken: "Cajun Chicken",
        prep_notes: "",
        cook_notes: ""
      }
    ]
  });
  assert.match(rendered, /Wednesday\* · dining out/);
  assert.match(rendered, /Note: Dinner with friends/);
  assert.match(rendered, /Thursday\* · sabzi/);
  assert.doesNotMatch(rendered, /Main: null/);
});

test("agent responses never turn an empty mutation result into a vague success", () => {
  assert.equal(
    resolveAgentAnswer("", ["Updated Saturday: main Egg Curry → Cheela Chutney."]),
    "Updated Saturday: main Egg Curry → Cheela Chutney."
  );
  assert.throws(
    () => resolveAgentAnswer("", []),
    /empty response without completing an action/
  );
  assert.equal(resolveAgentAnswer("  Changed it.  ", []), "Changed it.");
  assert.equal(
    summarizeToolAction(
      "move_menu_day",
      { from_day: "Thursday", to_day: "Wednesday" },
      {}
    ),
    "Moved the complete meal from Thursday to Wednesday."
  );
});

test("agent instructions forbid unrequested meal relocation", () => {
  assert.match(AGENT_SYSTEM_PROMPT, /principle of least change/i);
  assert.match(AGENT_SYSTEM_PROMPT, /only mark Saturday dining_out/i);
  assert.match(AGENT_SYSTEM_PROMPT, /Call move_menu_day only when the user explicitly/i);
});

test("menu facts expose valid non-consecutive side choices", () => {
  const menu = {
    days: [
      { day: "Monday", slot_type: "sabzi", side_chicken: "Side A" },
      { day: "Tuesday", slot_type: "chicken_main", side_chicken: null },
      { day: "Thursday", slot_type: "paneer_main", side_chicken: "Side B" },
      { day: "Friday", slot_type: "carb_heavy", side_chicken: "Side C" },
      { day: "Saturday", slot_type: "random", side_chicken: null }
    ]
  };
  const dishes = ["Side A", "Side B", "Side C"].map((name) => ({
    name,
    category: "dry_chicken",
    active: true
  }));
  const facts = buildMenuFacts(menu, dishes);
  assert.deepEqual(facts.eligible_days_without_a_side, ["Saturday"]);
  assert.deepEqual(facts.valid_sides_for_uncovered_days.Saturday, ["Side A", "Side B"]);
  assert.match(facts.side_allocation_rule, /not on consecutive scheduled meal days/);
});

test("meal composition facts prevent two main dishes in ad-hoc recommendations", () => {
  const dishes = [
    { name: "Chicken Curry", category: "chicken_main", active: true },
    { name: "Aloo Gobi", category: "sabzi", active: true },
    { name: "Palak Paneer", category: "paneer_main", active: true },
    { name: "Lemon Chicken", category: "dry_chicken", active: true },
    { name: "Disabled Side", category: "dry_chicken", active: false }
  ];
  const facts = buildMenuFacts(null, dishes);

  assert.equal(facts.menu_available, false);
  assert.deepEqual(facts.chicken_main_dishes, ["Chicken Curry"]);
  assert.deepEqual(facts.non_chicken_main_dishes, ["Aloo Gobi", "Palak Paneer"]);
  assert.deepEqual(facts.valid_catalogued_side_dishes, ["Lemon Chicken"]);
  assert.match(facts.meal_composition_rule, /exactly one substantial main dish/);
  assert.match(facts.meal_composition_rule, /chicken_main is a complete standalone main/);
});

test("group messages trigger only for this bot, replies to it, or commands", () => {
  const botInfo = { id: 42, username: "heisenberg_chef_bot" };
  assert.equal(
    shouldRespondToMessage(
      {
        text: "Hey @heisenberg_chef_bot, update Saturday",
        entities: [{
          type: "mention",
          offset: 4,
          length: "@heisenberg_chef_bot".length
        }]
      },
      botInfo
    ),
    true
  );
  assert.equal(
    shouldRespondToMessage(
      {
        text: "Continue",
        reply_to_message: { from: { id: 42, is_bot: true } }
      },
      botInfo
    ),
    true
  );
  assert.equal(shouldRespondToMessage({ text: "/menu" }, botInfo), true);
  assert.equal(
    shouldRespondToMessage(
      {
        text: "Hey @some_other_bot",
        entities: [{ type: "mention", offset: 4, length: 15 }]
      },
      botInfo
    ),
    false
  );
  assert.equal(
    shouldRespondToMessage({ text: "What are we cooking this week?" }, botInfo),
    false
  );
});

test("Telegram senders retain stable, distinct household identities", () => {
  assert.deepEqual(
    normalizeTelegramSender({
      id: 101,
      first_name: "Aniket",
      last_name: "Singh",
      username: "aniket"
    }),
    {
      telegram_user_id: "101",
      display_name: "Aniket Singh",
      username: "aniket"
    }
  );
  assert.deepEqual(
    normalizeTelegramSender({
      id: 202,
      first_name: "Rahul",
      username: "rahul"
    }),
    {
      telegram_user_id: "202",
      display_name: "Rahul",
      username: "rahul"
    }
  );
});

test("Telegram long polling starts without blocking the application lifecycle", async () => {
  const statuses = [];
  let finishPolling;
  const originalLog = console.log;
  const fakeBot = {
    launch(_config, onLaunch) {
      onLaunch();
      return new Promise((resolve) => {
        finishPolling = resolve;
      });
    }
  };

  console.log = () => {};
  try {
    assert.equal(
      launchTelegramBotInBackground(fakeBot, (status) => statuses.push(status)),
      fakeBot
    );
    assert.deepEqual(statuses, ["healthy"]);

    finishPolling();
    await Promise.resolve();
  } finally {
    console.log = originalLog;
  }
});

test("Telegram launch failures update component health", async () => {
  const statuses = [];
  const originalError = console.error;
  console.error = () => {};
  try {
    launchTelegramBotInBackground(
      {
        launch() {
          return Promise.reject(new Error("Telegram unavailable"));
        }
      },
      (status) => statuses.push(status)
    );
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    console.error = originalError;
  }

  assert.deepEqual(statuses, ["failed"]);
});

test("Telegram agent tools use OpenAI-compatible top-level schemas", () => {
  const unsupportedTopLevelKeywords = [
    "oneOf",
    "anyOf",
    "allOf",
    "enum",
    "const",
    "not"
  ];

  for (const tool of toolDefinitions) {
    assert.equal(
      tool.parameters.type,
      "object",
      `${tool.name} must use a top-level object schema`
    );
    for (const keyword of unsupportedTopLevelKeywords) {
      assert.equal(
        tool.parameters[keyword],
        undefined,
        `${tool.name} cannot use top-level ${keyword}`
      );
    }
  }
});

test("Terra tool calls use the supported Chat Completions reasoning mode", () => {
  assert.equal(resolveAgentReasoningEffort("gpt-5.6-terra", "low"), "none");
  assert.equal(
    resolveAgentReasoningEffort("gpt-5.6-terra-2026-08-01", "high"),
    "none"
  );
  assert.equal(resolveAgentReasoningEffort("gpt-5-mini", "low"), "low");
});
