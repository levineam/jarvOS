# Flush Timing Spec (D3)

**Defect:** `D3` — Short sessions never hit the pre-compaction flush threshold and lose all durable context.

**Status:** Spec complete. Implementation pending gateway config update.

---

## Problem

`memoryFlush` is currently wired to fire only when the context window approaches
`softThresholdTokens: 32000`. Sessions that end before reaching this threshold — the
majority of focused work sessions — never trigger a flush. Everything durable in those
sessions is lost.

---

## Required flush triggers

Memory flush must be triggered by **two independent conditions**:

### 1. Pre-compaction flush (existing)

Flush fires when context token count crosses `softThresholdTokens`.

Current config:
```yaml
memoryFlush:
  enabled: true
  softThresholdTokens: 32000
```

This trigger is correct and should remain. It protects long sessions from total context loss.

### 2. Session-end flush (required)

Flush fires at session close/yield, regardless of context size.

This is the critical missing trigger. Every session exit — clean shutdown, user disconnect,
agent yield — should checkpoint whatever durable context accumulated during the session.

Proposed config addition:
```yaml
memoryFlush:
  enabled: true
  softThresholdTokens: 32000
  flushOnSessionEnd: true       # NEW: flush at every session close
```

The session-end flush uses the same prompt as the pre-compaction flush (see `FLUSH_QUALITY.md`).
It runs on the current transcript before the session context is discarded.

### 3. Time-based flush (optional, secondary)

For long-running sessions with active conversation, flush every 30 minutes of active
exchange as an additional safety net.

Proposed config addition:
```yaml
memoryFlush:
  enabled: true
  softThresholdTokens: 32000
  flushOnSessionEnd: true
  flushIntervalMinutes: 30      # OPTIONAL: periodic flush during active sessions
```

This catches cases where a session runs for hours with lots of back-and-forth but never
compacts — the time-based flush ensures a mid-session checkpoint exists.

---

## Flush target

All flush triggers write to the same target: the canonical memory surfaces defined in
`MEMORY_SCHEMA_AND_AUDIT_HELPERS.md`:

- `MEMORY.md` (facts, preferences)
- `memory/decisions/*.md` (durable decisions)
- `memory/lessons/*.md` (corrections, lessons)
- `memory/projects/<slug>` (project-state snapshots)

The flush does **not** create daily journal entries. Daily entries (`memory/YYYY-MM-DD.md`)
are a separate, append-only surface.

---

## Implementation path

1. Add `flushOnSessionEnd: true` to the gateway config under `agents.defaults.compaction.memoryFlush`.
2. Add `flushIntervalMinutes: 30` as optional config once session-end flush is validated.
3. Verify with a short test session: create a decision, end the session, confirm it appears in `memory/decisions/`.

---

## References

- `memory/decisions/2026-03-25-memory-flush-postcompaction.md` — current flush config decision
- `FLUSH_QUALITY.md` — flush prompt spec
- SUP-359, SUP-360
