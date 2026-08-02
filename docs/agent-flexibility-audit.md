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

### 6. The agent could overreach while trying to preserve the generated plan

When told that Saturday dinner was not needed, the agent moved Saturday's meal to Wednesday even though no relocation was requested. This preserved the generated meal count at the cost of violating user intent.

The agent now follows a least-change contract. Unavailability changes only the named day; moving, swapping, replacing, or regenerating requires explicit intent. First-class dining-out and skipped states mean deleting a planned meal is a valid result and no compensating meal is required.

## Audit follow-up integrated in this branch

- Stored menus now use a versioned flexible schema with zero to seven dinner entries. Any weekday can be planned, dining out, skipped, or unscheduled. Legacy menus migrate in place to schema version 2 without dropping data.
- Automatic generation deliberately retains its five-day contract. This gives the scheduled job a testable starting shape without making that shape immutable after generation.
- `modify_menu_day` is now an upsert operation: it can add a missing weekday, change a plan, record an unavailable day, or remove a day. Moving and swapping remain atomic operations for existing day bundles.
- Shared free-form household memories are supplied to automatic generation as soft planning context. Declarative custom rules remain available only when deterministic enforcement is actually wanted.
- Menu mutations keep a bounded audit trail containing source, actor, timestamp, request ID, and before/after data. Repeated request IDs return the original action receipt rather than applying the mutation twice.

## Remaining intentional boundaries

- The current schedule models one dinner per weekday. Lunch/dinner slots or multiple meals on one date would require changing the day key to a date-and-meal-slot identity.
- Dish categories still define the storage roles for main and dry-chicken side. The AI can recategorise dishes and explicit edits can override weekly category distribution, but the persisted main/side fields remain typed.
- Complex deterministic preference policies still need the declarative rule language. Nuanced preferences should normally be stored as household memory and interpreted by the AI.
- Telegram write authority remains limited to the configured trusted group and optional user allowlist. New external or destructive operations should continue using explicit authorization and audit receipts.

## Later patch: recipes

Recipes should be separate versioned records rather than large text fields on dishes. A practical model is:

- `recipes`: id, name, servings/yield, structured ingredients, ordered steps, equipment, prep time, cook time, notes, source/provenance, version, timestamps.
- `dishes`: add `default_recipe_id`; allow multiple recipe variants to reference one dish.
- Tools: create/update recipe, assign/unassign a recipe to a dish, get a dish recipe, and list variants.
- Safety: recipe text remains untrusted data, never prompt-level instructions; mutations retain actor/source audit metadata.
- Migration: existing dishes remain valid with no assigned recipe, so recipe adoption can be incremental.

That work remains intentionally separate from this branch so recipes receive their own schema migration, tool contract, and tests.
