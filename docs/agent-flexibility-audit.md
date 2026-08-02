# Agent flexibility audit

## Goal

Heisenberg should store household data and expose safe operations. The AI should interpret natural language, make planning judgments, compose operations, and report what actually changed.

## Findings

### 1. A day-only mutation could report success without changing data

`modify_menu_day` previously required only `day`. The model could call it with `{ "day": "Saturday" }`; the store would validate and rewrite the unchanged menu, and the agent could then reply `Done.` This matches the observed replacement failure.

The tool and store now require at least one concrete changed field, reject normalized no-ops, and return a before/after action receipt.

### 2. Storage validation also enforced planning taste

Manual changes passed through the same validator as generated menus. That made rotation, exact slot distribution, category quotas, recent-history avoidance, pairing preferences, and prep conventions hard constraints even when a person explicitly requested an override.

Validation now has two modes:

- Generation mode enforces the full weekly planning policy.
- Manual mode protects representation and referential integrity while allowing explicit overrides of planning defaults.

The retained storage constraints are deliberately narrow: the menu shape must parse, weekdays must be unique, referenced dishes must be active and known, mains cannot use a side-only category, sides must use the side category, and a standalone chicken main cannot also carry a chicken side.

### 3. The agent had no truthful fallback after a tool call

An empty final model message was converted to `Done.` regardless of whether anything meaningful happened. Successful mutations now supply deterministic action summaries. If the model returns no prose after acting, the exact receipt is sent instead. An empty response with no completed action is an error, not success.

### 4. The prompt blurred defaults and commands

The prompt described planning rules as universally mandatory. It now states that generated-menu rules are defaults and that direct edits are household overrides. Open-ended requests such as “choose another dish” require the agent to select a concrete active alternative, call the mutation, and report the before/after result.

### 5. Tool planning was configured with no reasoning effort

The Telegram agent used `reasoning_effort: "none"`. This is now configurable through `OPENAI_AGENT_REASONING_EFFORT` and defaults to `low`, giving multi-step tool decisions some planning budget without materially increasing normal usage.

## Remaining constraints worth revisiting

- A menu still has exactly five entries. Supporting arbitrary numbers of meals, skipped days, lunch/dinner slots, or “dining out” as a first-class state needs a versioned menu schema rather than prompt changes.
- Dish categories still encode meal composition. This is useful today, but a future model could replace fixed categories with flexible roles or meal components.
- Preferences use a small declarative rule language. Durable free-form memory covers softer context, but complex policies may eventually need typed conditions and priorities.
- The agent currently has broad write authority inside one trusted Telegram group. Higher-impact future tools should keep audit metadata and idempotency keys.

## Later patch: recipes

Recipes should be separate versioned records rather than large text fields on dishes. A practical model is:

- `recipes`: id, name, servings/yield, structured ingredients, ordered steps, equipment, prep time, cook time, notes, source/provenance, version, timestamps.
- `dishes`: add `default_recipe_id`; allow multiple recipe variants to reference one dish.
- Tools: create/update recipe, assign/unassign a recipe to a dish, get a dish recipe, and list variants.
- Safety: recipe text remains untrusted data, never prompt-level instructions; mutations retain actor/source audit metadata.
- Migration: existing dishes remain valid with no assigned recipe, so recipe adoption can be incremental.

That work is intentionally kept out of this patch so the menu-action fix stays reviewable and does not mix a storage migration with agent behavior changes.
