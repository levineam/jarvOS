# JarvOS Architecture

JarvOS is the personalization layer that makes OpenClaw work for a specific person.
It knows who you are, remembers what happened, and gets better the longer you use it.

OpenClaw is the runtime. JarvOS is the reason it feels like yours.

---

## Three modules

JarvOS has three top-level modules. Each has a single job.

### jarvos-memory — what the agent knows

**Scope:** Compact durable recall that agents read to operate across sessions.

Owns: facts, preferences, decisions, lessons, project-state snapshots.

Does not own: raw daily logs, long-form notes, conversation transcripts,
runtime compaction internals, or live Paperclip task state.

Repository home: `jarvos-memory/`

### jarvos-ontology — who the human is

**Scope:** Structured belief graph, predictions, goals, values, and identity.

Owns: beliefs, predictions, core self (mission + values), goals, project-level
portfolio views, higher-order principles.

Does not own: day-to-day operational memory, raw note content, or execution tracking.

Repository home: `jarvos-ontology/`

### jarvos-secondbrain — what the human wrote

**Scope:** Content layer for durable knowledge and chronological intake.

Two sub-packages:

- **jarvos-secondbrain-journal** — chronological daily intake, rough capture,
  day-scoped awareness snapshots.
- **jarvos-secondbrain-notes** — durable standalone knowledge artifacts:
  architecture docs, research, decisions, references.

Does not own: compact agent memory, ontology state, or Paperclip execution state.

Repository home: `jarvos-secondbrain/`

---

## The distinction that matters

**Agent state** vs **content**.

- **jarvos-memory** and **jarvos-ontology** are agent-facing. Agents read them to
  operate. They are compact, structured, and optimized for recall.
- **jarvos-secondbrain** is content-facing. The human wrote it (or agents wrote
  it for them). It is rich, long-form, and optimized for human reading in
  Markdown tools such as Obsidian.

Memory is what Jarvis knows. Ontology is who the human is. Secondbrain is what
the human and their agents captured and organized.

---

## Data flow

Information flows through JarvOS in one direction, with bounded reflection back.

```
Journal intake (daily capture)
    │
    ▼
Notes promotion (durable knowledge extracted from daily context)
    │
    ▼
Memory update (compact recall distilled from notes and daily logs)
    │
    ▼
Ontology shaping (beliefs, goals, and identity refined from durable signals)
```

### Promotion rules

- **Journal → Notes:** When a day's rough capture contains something worth standing
  on its own — an architecture decision, a research finding, a reusable reference.
- **Journal/Notes → Memory:** When a fact, preference, decision, lesson, or project
  state is compact enough to scan quickly and likely to matter in a future session.
- **Memory → Ontology:** When a durable signal reveals or updates a belief, goal,
  prediction, value, or identity element.

### Bounded reflection back

- **Paperclip → Journal:** Meaningful completions, blockers, and decisions reflect
  back as awareness entries in the daily journal. Not status churn.
- **Ontology → Memory:** Ontology health checks may surface stale or orphaned state
  that updates or invalidates memory entries.

### What does not flow

- Raw execution churn from Paperclip does not mirror into secondbrain.
- Runtime compaction summaries do not become canonical memory.
- Day-specific operational logs do not promote into memory unless they contain
  a genuinely durable signal.

---

## External system boundaries

### Paperclip

Paperclip is the execution authority. It owns:
- issue assignment, status, ownership, prioritization
- done/not-done state and closeout evidence

JarvOS does not duplicate Paperclip's job. The relationship is:
- JarvOS captures meaning and context around work.
- Paperclip tracks and closes the work itself.
- Bridges connect them: promotion (secondbrain → Paperclip) and reflection
  (Paperclip → journal).

### OpenClaw runtime

OpenClaw provides the agent runtime: sessions, compaction, context engines,
tool orchestration.

JarvOS uses OpenClaw but is not defined by it:
- `lossless-claw` (context engine) manages transcript continuity and may emit
  candidates for memory promotion, but it is not jarvos-memory.
- Compaction configuration (`postCompactionSections`, `memoryFlush`) is an
  adapter concern, not a module definition.
- Context pruning rules are operational wiring, not the memory schema.

### Obsidian

Obsidian is the current reading/editing surface for secondbrain content.
JarvOS is Markdown-first and Obsidian-optional. Nothing in the architecture
requires Obsidian to function, but the content should be pleasant to read there.

JarvOS v0.3 makes this explicit through `@jarvos/skills` and its
`obsidian-default` experience pack:

- Obsidian is the default front door for Markdown notes, journals, canvases, and
  review views.
- `jarvos-secondbrain` remains the owner of note and journal contracts.
- `obsidian-cli` and `defuddle` are detected as optional tools, not assumed.
- Obsidian Bases and Canvas files are artifacts and review surfaces. They must
  not become the live project/status system; Paperclip retains that authority.

---

## Legacy deprecation

### Superseded names

| Old name | New name | Status |
| --- | --- | --- |
| `claw-secondbrain` | `jarvos-secondbrain` | done |
| `claw-secondbrain-journal` | `jarvos-secondbrain-journal` | done |
| `claw-secondbrain-notes` | `jarvos-secondbrain-notes` | done |
| `claw-secondbrain-memory` | removed — replaced by `jarvos-memory` | done |
| `claw-ontology` | `jarvos-ontology` | done |

### Superseded surfaces

| Surface | Status | Replacement |
| --- | --- | --- |
| `Tasks.md` (vault) | compatibility-only | Paperclip |
| Vault project boards | compatibility-only | Paperclip |
| `journal-task-sync.js` task mirroring | compatibility-only | source-specific journal sections |

These surfaces are preserved for historical reference but must not be used for
active task dispatch or execution authority.

---

## Module layout (current working state)

```text
clawd/
├── jarvos/
│   └── ARCHITECTURE.md          ← this file
├── jarvos-skills/               ← experience packs and install doctors
├── jarvos-memory/               ← agent state: compact durable recall
│   ├── docs/
│   ├── scripts/
│   └── src/
├── jarvos-ontology/             ← belief graph and identity
│   ├── ontology/
│   ├── schema/
│   ├── scripts/
│   └── src/
├── jarvos-secondbrain/          ← content layer
│   ├── packages/
│   │   ├── jarvos-secondbrain-journal/
│   │   └── jarvos-secondbrain-notes/
│   ├── bridge/
│   │   ├── paperclip/
│   │   ├── provenance/
│   │   └── routing/
│   └── adapters/
│       ├── openclaw/
│       └── obsidian/
├── config/
│   └── journal-module.json      ← journal structure contract
├── scripts/                     ← operational scripts (bridges, maintenance)
├── memory/                      ← working memory surfaces
│   ├── decisions/
│   ├── lessons/
│   └── projects/
├── MEMORY.md                    ← curated durable memory registry
└── docs/                        ← architecture decisions and contracts
```

---

## Context management responsibilities

Context management is a jarvos-memory concern, not a secondbrain concern.

Specifically, jarvos-memory must address:
- **Flush timing (D3):** Capture durable context from short sessions, not just
  pre-compaction flushes.
- **Flush quality (D4):** Use targeted prompts that capture decisions, corrections,
  preferences, and plan-critical state.
- **Context pruning (D5):** Define rules for pruning stale tool outputs before they
  crowd real conversation.
- **Compaction survival (D6):** Define what behavioral rules and conversation detail
  survive compaction.
- **Transcript search (D7):** Make conversation transcript search a first-class
  capability, not a bolt-on.
- **Watchdog safety (D8):** Module must not trigger context watchdog alerts under
  normal operation.

These are documented in the jarvos-memory module and should be tracked in the
project system used by the local installation.

---

## Bridge responsibilities (JarvOS level)

Bridges live at the JarvOS root, not inside any sub-module.

- **Paperclip promotion bridge:** secondbrain capture → plan → review → apply into
  Paperclip issues. Preserves the reviewRequired gate.
- **Paperclip reflection bridge:** meaningful Paperclip events → bounded journal
  entries. Filters low-signal status churn.
- **Ontology candidate routing:** capture router identifies ontology signals →
  adapter creates artifacts in jarvos-ontology.
- **Provenance bridge:** note ↔ journal backlinks, cross-module integrity audits.

---

## Success definition

JarvOS is working when:

1. The human can open today's journal in their Markdown workspace and understand
   what happened across all projects without asking an agent.
2. Agents wake up in a new session and know what matters without re-reading
   everything from scratch.
3. Durable decisions, corrections, and preferences survive compaction and session
   boundaries.
4. Paperclip remains the sole execution authority. JarvOS captures meaning around
   work, not the work itself.
5. Each module has a clear, non-overlapping scope statement. No boundary confusion.

---

*This document is the canonical JarvOS architecture reference.*
*Last updated: 2026-03-25.*
