# Transcript Search Spec (D7)

**Defect:** `D7` — Transcript search exists as a bolt-on QMD feature, not as a first-class jarvos-memory capability.

**Status:** Spec complete. Current QMD bolt-on remains in use pending first-class integration.

---

## Problem

Session transcripts are the richest source of agent memory — every decision, correction,
and preference was originally stated in a transcript. Right now, agents can only search
memory files (MEMORY.md, decisions, lessons). Searching *what actually happened* in prior
conversations is not a documented, supported path.

The QMD skill provides session transcript indexing as a separate tool, but it is not
connected to the jarvos-memory module. Agents discover it ad-hoc rather than through
a defined capability contract.

---

## What "first-class" means

A first-class capability in jarvos-memory means:
1. **Documented** — the capability is described in this module, not hidden in a skill README
2. **Discoverable** — agents know to use it; it's part of the memory query surface
3. **Contractual** — there is a defined interface for searching transcripts, not just "use QMD somehow"
4. **Complementary** — it works alongside memory files, not as an alternative

Transcript search does NOT replace `MEMORY.md` or `memory/decisions/`. Transcripts are
the *source material*. Promoted memory entries are the *distilled result*. Both are
queryable through first-class paths.

---

## Transcript search contract

### What transcripts contain

Session transcripts hold the raw record of every agent-user exchange. They contain:
- decisions at the moment they were made, before promotion to memory
- corrections stated by the user in context
- tool calls and their outputs at the time
- session-specific reasoning that may not have been promoted

### When to search transcripts vs. memory files

| Use case | Search target |
|---|---|
| "What did I decide about X?" | `memory/decisions/` first, then transcripts if not found |
| "Did we ever discuss Y?" | Transcripts — this is a recall/discovery query |
| "What was the exact wording of the correction about Z?" | Transcripts — memory files store distilled outcomes |
| "What preferences has Andrew stated?" | `MEMORY.md` first, then transcripts for recent sessions |
| "What was the last tool output for this file?" | Transcripts only (tool outputs are not promoted to memory) |

### Search interface

Current path (QMD bolt-on, to be formalized):
```bash
# Via QMD skill
qmd search --index session-transcripts "<query>"
```

Future path (first-class, pending implementation):
```bash
# Via jarvos-memory module
node jarvos-memory/scripts/search-transcripts.js "<query>"
node jarvos-memory/scripts/search-transcripts.js "<query>" --since 7d
node jarvos-memory/scripts/search-transcripts.js "<query>" --json
```

The first-class script should:
- Accept a query string
- Search indexed session transcripts via QMD or a compatible index
- Return ranked results with session date, snippet, and a path to the full transcript
- Support `--since <period>` to limit scope
- Support `--json` for machine-readable output

---

## Transcript index

Transcripts are indexed by the QMD session indexing pipeline. Index location and query
semantics are defined by the QMD skill (`~/clawd/skills/qmd/SKILL.md`).

The jarvos-memory module treats the transcript index as an external dependency — it
queries the index but does not own or rebuild it.

**Index freshness:** The transcript index must be updated after each session ends. This is
currently a manual step or a cron job. The session-end flush (see `FLUSH_TIMING.md`)
should also trigger an index update.

---

## Integration with memory promotion

Transcript search is the discovery path that feeds memory promotion:

```
Agent searches transcripts for past context
  → finds relevant session
  → if the context is worth keeping long-term: promotes to memory/decisions/ or MEMORY.md
  → promotion follows rules in MEMORY_PROMOTION_RULES.md
```

This closes the loop: transcripts → search → promote → memory → search (next time, faster).

---

## Implementation roadmap

| Step | Description | Status |
|---|---|---|
| 1 | QMD session indexing as bolt-on | ✅ Done |
| 2 | Document first-class contract (this file) | ✅ Done |
| 3 | `search-transcripts.js` script in jarvos-memory/scripts/ | ⬜ Pending |
| 4 | Wire session-end flush to also trigger index update | ⬜ Pending (depends on D3) |

---

## References

- `~/clawd/skills/qmd/SKILL.md` — QMD skill documentation
- `FLUSH_TIMING.md` — session-end flush (D3) — index update hook
- `MEMORY_PROMOTION_RULES.md` — promotion rules for content found via transcript search
- SUP-359, SUP-360
