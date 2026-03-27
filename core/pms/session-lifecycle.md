# Session Lifecycle Pattern

A structured read cache of PMS project board state that lets your AI assistant reason about current work without re-parsing every board on every request.

## What It Does

Instead of scanning all active project boards on every heartbeat, the lifecycle pattern creates a **single structured snapshot** of your project state. Consumers (outcome engine, morning briefing, reflection watchdog) read the snapshot rather than the raw boards.

This decouples "where is my work?" from "what do I do with that information?" — and makes the whole system faster and more composable.

## The Snapshot Schema

The lifecycle state object has six fields:

| Field | Type | Description |
|-------|------|-------------|
| `working_on` | `string[]` | In-progress tasks across all active boards. Format: `[Board Name] task description` |
| `blocked` | `string[]` | Active blockers across all boards. Format: `[Board Name] blocker description` |
| `decisions` | `string[]` | Last 5 decisions from board decision tables. Format: `[date] decision (Board Name)` |
| `next` | `string \| null` | First unblocked next task found across boards |
| `updated_at` | `string` | ISO 8601 timestamp of last sync |
| `source` | `string` | Identifies the producer (e.g. `"session-lifecycle"`) |

## How It Works

```
PMS Boards (active only)
        │
        ▼
  Lifecycle Sync         ← runs on a schedule or after reflection
        │
        ▼
  Heartbeat State        ← single JSON file, `sessionLifecycle` key
        │
   ┌────┼────┐
   ▼    ▼    ▼
 Outcome Briefing Reflection
 Engine  Script  Watchdog
```

**Step 1 — Discovery:** Find all active project boards. "Active" means the board document has `status: active` in its frontmatter.

**Step 2 — Extraction:** For each active board, extract four things:
- **In-progress tasks:** Table rows or checklist items marked as "In Progress" or equivalent
- **Blockers:** Entries in the Blockers section (excluding placeholder/empty entries)
- **Decisions:** The most recent entries from the Decisions log table
- **Next task:** The first "Ready" or "To Do" item, or an explicit `**Next:**` annotation

**Step 3 — Aggregation:** Merge results across all boards. Prefix each item with its board name so consumers know the source. Keep only the 5 most recent decisions by date.

**Step 4 — Persist:** Write the snapshot to your heartbeat state store. The key should be stable (e.g. `sessionLifecycle`) so consumers can always find it.

## Consumer Contract

Consumers read the snapshot via a `readLifecycle()` function with a freshness check:

- If the snapshot is **fresh** (within 2 hours by default), return it as-is
- If the snapshot is **stale** or missing, return `null` — consumers must handle this gracefully

**Every consumer must have a fallback.** If the lifecycle state is null, the consumer should either skip the feature or fall back to its own board-reading logic. This ensures the pattern is always additive, never blocking.

### Recommended consumer behaviors

| Consumer | Uses | Fallback |
|----------|------|----------|
| Outcome engine | `working_on` for WIP detection | Direct board scan |
| Morning briefing | All fields for "Current Work State" section | Omit section |
| Reflection watchdog | Triggers sync after reflection pass | Continues normally |

## Freshness Expectations

- **Sync cadence:** After reflection passes, or on-demand. Not necessarily every heartbeat.
- **Default stale threshold:** 2 hours. Can be overridden per consumer (e.g., morning briefing may use 4 hours).
- **If stale:** Consumers receive `null` and fall back. No errors, no blocking.

## Implementing in Any Runtime

The pattern has four components you need to implement:

### 1. Board Discovery

Write a function that returns paths to all your active project board files. "Active" is typically a frontmatter field (`status: active`), but use whatever convention your PMS uses.

### 2. Board Parser

Write a function that reads one board and returns:
```
{
  board: "Board Name",
  working_on: ["task 1", "task 2"],
  blocked: ["blocker 1"],
  decisions: [{ date: "2026-01-15", decision: "Chose approach X" }],
  next: "Next task or null"
}
```

The exact parsing logic depends on your board format. The key insight is that you return a **structured object**, not raw markdown.

### 3. Aggregator

Merge results across all boards into a single snapshot object. Add `updated_at` and `source` fields.

### 4. State Store

Persist the snapshot somewhere your consumers can read it. A JSON file (heartbeat state) works well. Consumers should:
- Check `updated_at` against a max-age threshold
- Return `null` if stale or missing
- Never throw — always fail soft

## Why This Pattern

**Without it:** Every consumer (briefing, reflection, outcome engine) independently scans all project boards. This is slow, duplicated logic, and inconsistent — different consumers may see different board states if boards change mid-session.

**With it:** One sync, one snapshot, many cheap reads. Board state is consistent across all consumers within a session. Stale data is handled uniformly.

The pattern is especially valuable when you have many active projects (5+) or when consumers run frequently.

## Board Format Conventions

This pattern works with any board format, but works best when boards follow consistent conventions:

- **Status field:** frontmatter `status: active` / `status: archived`
- **In-progress marker:** "In Progress" text or an emoji in task table rows
- **Blockers section:** `## Blockers` heading with a table
- **Decisions section:** `## Decisions` heading with dated entries
- **Next annotation:** `**Next:** task description` at the top of the board

If your boards use different conventions, update the parser accordingly — the interface stays the same.
