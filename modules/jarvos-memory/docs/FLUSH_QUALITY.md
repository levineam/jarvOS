# Flush Quality Spec (D4)

**Defect:** `D4` — The current flush prompt exists but is imprecise about what to capture and what to skip.

**Status:** Spec complete. Current prompt is functional; this spec tightens the contract.

---

## Problem

A flush prompt that captures everything produces bloated MEMORY.md entries that are hard to
scan and add noise rather than signal. A prompt that captures too little misses the durable
decisions and corrections that make cross-session continuity useful.

The current prompt is a reasonable start. This spec formalizes the targeted contract.

---

## Flush prompt contract

### Capture — what the flush MUST extract

| Category | Examples |
|---|---|
| **Decisions made** | Architecture choices, implementation paths chosen, things explicitly settled |
| **Corrections given** | Mistakes identified, misunderstandings cleared up, factual corrections by the user |
| **Preferences stated** | "I prefer X over Y", formatting preferences, workflow preferences |
| **Open questions** | Explicit unresolved questions, things deferred to next session |
| **New resources** | URLs, files, tools, or references introduced that will be useful later |
| **Plan-critical state** | Current position in a multi-step plan, blockers, next concrete action |

### Skip — what the flush MUST NOT capture

| Category | Why |
|---|---|
| **Timestamps and event log entries** | Raw chronology belongs in daily journal, not MEMORY.md |
| **Conversation rewriting** | The flush is not a transcript summary. Capture *outcomes*, not exchanges. |
| **Things already in MEMORY.md** | Do not repeat stable facts/preferences already there. Update them if they changed; otherwise skip. |
| **Tool outputs and read-back content** | Large file reads, search results, and scaffolding output are transient. Don't preserve them. |
| **Routine confirmations** | "Yes, I did X" confirmations of work already visible in git/Paperclip are not durable memory. |

---

## Prompt spec

The flush uses a **two-message prompt structure**:

### System message (sets role and format)
```
You are a memory extraction assistant. Extract durable facts, decisions, preferences,
corrections, open questions, new resources, and plan-critical state from this conversation.
Output terse bullet points. No narrative. No timestamps. No conversation rewriting.
Skip anything already present in MEMORY.md.
```

### User message (provides context)
```
Here is the conversation so far. Extract memory entries according to the schema.

<conversation>
[transcript]
</conversation>

<current_memory>
[contents of MEMORY.md]
</current_memory>
```

---

## Output format

Flush output is structured as one of the core memory classes from
`MEMORY_SCHEMA_AND_AUDIT_HELPERS.md`:

- **facts / preferences** → bullet entries formatted for `MEMORY.md`
- **decisions** → frontmatter record for `memory/decisions/YYYY-MM-DD-slug.md`
- **lessons** → frontmatter record for `memory/lessons/YYYY-MM-DD-slug.md`
- **project-state** → update to `memory/projects/<slug>`

The flush agent must route output to the correct surface rather than dumping everything
into MEMORY.md.

---

## Quality check criteria

A flush output is **good** if:
- Every entry is actionable or usable in a future session without context
- The total addition is under 500 tokens for a typical session
- No entry duplicates what's already in MEMORY.md

A flush output is **bad** if:
- It contains conversation turns ("Andrew asked... Michael replied...")
- It contains raw timestamps
- It restates the session topic as a fact
- It repeats existing MEMORY.md content verbatim

---

## References

- `memory/decisions/2026-03-25-memory-flush-postcompaction.md` — original flush prompt decision
- `FLUSH_TIMING.md` — flush trigger spec (D3)
- `MEMORY_SCHEMA_AND_AUDIT_HELPERS.md` — memory class schema
- SUP-359, SUP-360
