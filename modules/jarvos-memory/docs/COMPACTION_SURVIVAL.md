# Compaction Survival Spec (D6)

**Defect:** `D6` — What must survive compaction is undocumented. Behavioral rules and safety constraints drift post-compaction.

**Status:** Spec complete. `postCompactionSections` mechanism is active.

---

## Problem

OpenClaw context compaction summarizes the conversation history to reclaim context space.
Without intervention, critical behavioral rules, safety constraints, and active task context
injected at session start get compressed or dropped during summarization. This causes
observable drift: the agent forgets constraints mid-conversation.

---

## What must survive compaction

Three categories of content must persist across compaction boundaries:

### 1. Behavioral rules

Rules that govern how the agent operates — response style, format constraints, tool
usage rules, communication defaults. These define the agent's operating contract and
must remain active for the full session lifetime.

Examples from `AGENTS.md`:
- "trash > rm (recoverable beats gone forever)"
- "Every code subagent spawn MUST reference a Paperclip issue"
- Platform-specific formatting rules (no markdown tables in Discord, etc.)

### 2. Safety constraints

Hard stops and red lines that must never be dropped. These are the highest-priority
survival requirement.

Examples:
- "Don't exfiltrate private data. Ever."
- "Don't run destructive commands without asking."
- "Ask first for anything that leaves the machine."

### 3. Active task context

The current task state — what the agent is in the middle of, what the next concrete step
is, what's been decided so far. Without this, post-compaction the agent loses its place.

This is handled via **memory flush before compaction** (see `FLUSH_TIMING.md`):
- durable decisions go into `memory/decisions/`
- plan-critical state goes into `memory/projects/<slug>`
- active task context re-enters context as workspace file reads after compaction

---

## Current implementation: postCompactionSections

The `postCompactionSections` mechanism re-injects critical content immediately after
compaction completes. It is the current runtime answer to behavioral and safety rule drift.

Config (`agents.defaults.compaction.postCompactionSections`):
```yaml
postCompactionSections:
  - "Critical Rules"
  - "Problem-Solving Behavior"
  - "Memory Organization"
  - "Do-First Rule"
```

These are H2 section headings in `AGENTS.md`. After compaction, OpenClaw re-reads these
sections from `AGENTS.md` and injects them at the top of the compacted context, ensuring
behavioral rules and safety constraints are present in the new context window.

**Why H2 headings:** The mechanism uses section headings as stable anchors. If `AGENTS.md`
is updated, the sections are re-read from the current file — there is no stale cached copy.

---

## Survival matrix

| Content type | Survival mechanism |
|---|---|
| Behavioral rules | `postCompactionSections` re-injection |
| Safety constraints | `postCompactionSections` re-injection |
| Active task decisions | `memoryFlush` → `memory/decisions/` before compaction |
| Plan-critical state | `memoryFlush` → `memory/projects/<slug>` before compaction |
| Preferences | `memoryFlush` → `MEMORY.md` before compaction |
| Corrections | `memoryFlush` → `memory/lessons/` before compaction |
| Recent conversation turns | `recentTurnsPreserve: 4` + `keepRecentTokens: 20000` |

---

## What does NOT need to survive compaction

- Full conversation transcript — compaction summarizes it; that's fine
- Tool output content — stale tool outputs are pruned before compaction anyway
- Raw daily journal entries — these are content, not agent state
- Timestamps and event log lines — not durable memory

---

## Validation

After any compaction, verify survival by checking:
1. `postCompactionSections` contents appear in the active context (agent should still know its constraints)
2. `memory/decisions/` has a record for any decision made before compaction
3. The agent can describe its current task without being re-briefed

---

## References

- `memory/decisions/2026-03-25-memory-flush-postcompaction.md` — current implementation decision
- `FLUSH_TIMING.md` — flush trigger spec (D3)
- `CONTEXT_PRUNING.md` — pruning rules (D5)
- SUP-359, SUP-360
