import test from "node:test";
import assert from "node:assert/strict";
import {
  buildMenuFacts,
  normalizeTelegramSender
} from "../src/telegram/agent.js";
import { shouldRespondToMessage } from "../src/telegram/bot.js";
import { formatAgentResponse } from "../src/telegram/format.js";

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
