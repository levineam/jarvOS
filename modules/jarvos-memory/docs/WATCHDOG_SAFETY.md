# Watchdog Safety Contract (D8)

**Defect:** `D8` — jarvos-memory operations sometimes trigger context watchdog alerts under normal operation.

**Status:** Spec complete. Contract defines what "normal operation" means and what budget constraints must hold.

---

## Problem

The OpenClaw context watchdog fires alerts when context window usage exceeds safety
thresholds. If jarvos-memory operations (memory reads, flush writes, audit runs) are
themselves consuming enough context to push usage over threshold, they become
self-defeating: the memory system triggers the very problem it is meant to prevent.

---

## Contract: jarvos-memory operations must not trigger watchdog alerts under normal operation

This is a hard contract, not a guideline.

---

## Definition: normal operation

Normal operation means any of the following jarvos-memory activities during an active
session:

| Operation | Description |
|---|---|
| Memory read (startup) | Reading MEMORY.md, today's and yesterday's memory files at session start |
| Memory file read (on-demand) | Reading a specific decision, lesson, or project-state file |
| Audit run | Running `scripts/audit-memory.js` to check memory health |
| Flush write | Writing a flush output to memory/decisions/, memory/lessons/, or MEMORY.md |
| Transcript search | Running a transcript search query |
| postCompactionSections injection | Re-injecting behavioral rule sections after compaction |

Normal operation does **not** include:
- Reading the full decision/lessons/projects directory contents recursively
- Reading all transcripts into context
- Running multiple large memory operations in rapid succession within a single turn

---

## Budget constraints

jarvos-memory operations must stay within these limits to avoid watchdog triggers:

### Startup reads

| File | Max size loaded into context |
|---|---|
| `MEMORY.md` | ≤ 8,000 tokens |
| Today's daily memory (`memory/YYYY-MM-DD.md`) | ≤ 4,000 tokens |
| Yesterday's daily memory | ≤ 4,000 tokens |
| **Total startup read budget** | **≤ 16,000 tokens** |

If `MEMORY.md` exceeds 8,000 tokens, it is due for curation. See `MEMORY_PROMOTION_RULES.md`.

### On-demand reads

| Operation | Max tokens per read |
|---|---|
| Single decision file | ≤ 2,000 tokens |
| Single lesson file | ≤ 2,000 tokens |
| Single project-state file | ≤ 4,000 tokens |
| Audit output | ≤ 2,000 tokens |
| Transcript search result | ≤ 3,000 tokens (result set, not full transcripts) |

### Flush writes

Flush write operations produce output but do not load large content into context. Budget:
- Flush prompt input (transcript excerpt): ≤ 6,000 tokens
- Flush output (memory entries): ≤ 1,000 tokens

### postCompactionSections

Each re-injected section from AGENTS.md: ≤ 500 tokens per section.
Four sections currently re-injected: ≤ 2,000 tokens total.

---

## Watchdog trigger thresholds (reference)

The context watchdog fires alerts at:
- **Warning:** context window usage > 80% of model limit
- **Critical:** context window usage > 90% of model limit

jarvos-memory operations at the budget limits above consume at most ~20,000 tokens total
(startup + one on-demand read + postCompactionSections). For a 200K context model, this is
~10% of the window — well within budget.

If watchdog alerts fire during normal jarvos-memory operations, the root cause is almost
certainly not the memory operations themselves but one of:
1. `MEMORY.md` is over the 8K token limit (needs curation)
2. A memory file read was triggered multiple times in one turn (agent error)
3. The session was already near threshold before the memory operation ran

---

## Diagnostic checklist

If watchdog alerts occur during memory operations:

1. **Check MEMORY.md size**: `wc -w agents/michael/MEMORY.md` — curate if > 6,000 words
2. **Check daily memory files**: `wc -w memory/YYYY-MM-DD.md` — split if > 3,000 words
3. **Check audit output**: Run `node jarvos-memory/scripts/audit-memory.js --json | wc -c`
4. **Check for duplicate reads**: Review whether the same file was read multiple times
5. **Check pre-existing context pressure**: If the session was already at 70%+ before memory ops, the session has a pre-existing problem, not a memory problem

---

## Enforcement

The audit (`scripts/audit-memory.js`) does not currently check file sizes. A future audit
enhancement should warn when:
- `MEMORY.md` exceeds 8,000 tokens (~6,000 words)
- any single decision/lesson file exceeds 2,000 tokens (~1,500 words)

This gives an early warning before the watchdog fires.

---

## References

- `CONTEXT_PRUNING.md` — pruning rules that reduce context pressure before memory ops (D5)
- `COMPACTION_SURVIVAL.md` — postCompactionSections budget (D6)
- `FLUSH_TIMING.md` — flush budget constraints (D3)
- `MEMORY_SCHEMA_AND_AUDIT_HELPERS.md` — memory class schema and size conventions
- SUP-359, SUP-360
