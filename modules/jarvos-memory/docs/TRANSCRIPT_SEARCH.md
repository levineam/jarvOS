# Transcript Search Spec (D7)

**Defect:** `D7` — Transcript search exists as a bolt-on QMD feature, not as a first-class jarvos-memory capability.

**Status:** First-class contract and optional CASS adapter implemented. QMD remains a
supported additive backend in hosts that already use it.

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

The existing QMD path remains useful for markdown-first recall:
```bash
# Via QMD skill
qmd search --index session-transcripts "<query>"
```

The first-class jarvOS path is a bounded JSON packet. It uses CASS when the local
binary is configured and compatible, and returns an explicit `unavailable` packet
when it is not:
```bash
# Via jarvos-memory module
node jarvos-memory/scripts/search-transcripts.js "<query>"
node jarvos-memory/scripts/search-transcripts.js "<query>" --since 7d
node jarvos-memory/scripts/search-transcripts.js "<query>" --connector codex --json
node jarvos-memory/scripts/search-transcripts.js "<query>" --strict --max-evidence 8
```

The script always emits the same JSON shape as the library boundary; `--json` is
accepted for parity with CASS. It never prints raw CASS stderr or transcript paths.

The contract is provider-neutral, but the current adapter supports the local CASS
connectors `codex` and `claude_code` (CASS's `claude` alias is normalized). Retrieval
uses `cass api-version --json`, `cass capabilities --json`, and a lexical-only
`cass pack ... --json --mode lexical` call. It does not run `index`, `--watch`, refresh, semantic
model installation, export, support-bundle, or remote-source commands.

Each packet includes:

- `status`: `evidence_found`, `no_evidence`, `partial`, or `unavailable`
- searched/requested connectors and per-connector freshness/error outcomes
- bounded evidence with session identifier, timestamp, citation, excerpt, and an
  `untrustedContent: true` marker
- `truncated`, `omissions`, and a deterministic `renderedTokenCount`

The default aggregate packet budget is 3,000 estimated tokens; requested budgets are
normalized to a minimum of 512 estimated tokens so the packet envelope can be
returned without exceeding its own bound. Excerpts are locally redacted for common
credential-shaped values before they enter the packet. Paths are used only for local
provenance validation and are not returned in the ordinary agent packet. Transcript
evidence is source material, not a durable memory record.

---

## Transcript index

Transcripts may be indexed by QMD, CASS, or another compatible local provider. The
provider owns its own derived index; the jarvOS adapter owns only request validation,
bounded subprocess policy, provenance checks, redaction, status aggregation, and the
packet contract.

The jarvos-memory module treats every transcript index as an external dependency — it
queries the index but does not own or rebuild it during retrieval. CASS's explicit
index maintenance is a separate private-host operation, not part of an agent recall
request.

**Index freshness:** Freshness is reported by the provider and surfaced in the packet.
Strict consumers (such as a future nightly collector) must request strict freshness
and treat stale or failed connectors as partial/unavailable rather than silently
claiming exhaustive coverage. Index maintenance belongs to the host's bounded
post-session or scheduled workflow.

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
| 3 | `search-transcripts.js` plus the versioned provider-neutral packet | ✅ Done |
| 4 | Add conditional on-demand agent recall over the packet | 🔄 In progress in the agent-context adapter |
| 5 | Add proof-gated private index maintenance/nightly collection | ⬜ Pending host proof gate |

---

## References

- `~/clawd/skills/qmd/SKILL.md` — QMD skill documentation
- `FLUSH_TIMING.md` — session-end flush (D3) — index update hook
- `MEMORY_PROMOTION_RULES.md` — promotion rules for content found via transcript search
- SUP-359, SUP-360
