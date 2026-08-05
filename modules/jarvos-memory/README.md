# jarvos-memory

JarvOS-level agent-state memory contract, schema surface, stack map, and audit helpers.

This module is the home for **durable agent memory**: compact recall that helps Jarvis
and other agents operate across sessions without turning Memory into a second content
store.

## What this module is for

Use `jarvos-memory` for:
- stable facts worth reusing later
- preferences that change future decisions
- durable decisions with rationale
- lessons and corrections
- project-state snapshots worth carrying across days
- stack-map documentation for the full JarVOS memory stack
- the shared experience-memory adapter contract for optional agentmemory dogfood

## What this module is not for

### `jarvos-secondbrain`
`jarvos-secondbrain` remains the **content-facing** layer:
- Journal = day-by-day chronology and raw capture
- Notes = longer-form research, architecture, and source material

`jarvos-memory` is the **agent-facing** layer:
- compact retained state
- promotion rules
- provenance expectations
- lightweight audits

### `jarvos-ontology`
`jarvos-ontology` remains the worldview / graph layer.

Integration rule:
- Memory keeps compact retained state.
- Ontology turns the most important durable signals into structured beliefs, goals,
  projects, and relationships.
- Not every memory becomes ontology, but ontology should be informed by durable memory.

## Stack Map

The current package name is `@claw/jarvos-memory`; the architecture shorthand is
`@jarvos/memory`. This module is the compact memory registry and boundary contract,
not a runtime router.

Detailed stack-map documentation lives in:
- `docs/STACK_MAP.md`

Optional shared experience-memory dogfood is governed by:
- `docs/EXPERIENCE_MEMORY_AGENTMEMORY_CONTRACT.md`

## Current canonical memory surfaces

During this bootstrap phase, the module owns these working surfaces in `clawd/`:
- `MEMORY.md`
- `memory/decisions/`
- `memory/lessons/`
- `memory/projects/`

Current project-state handling is intentionally conservative:
- `memory/projects/` is the canonical project-state container
- the bootstrap accepts either `memory/projects/<slug>.md` or `memory/projects/<slug>/`
- this module does **not** force a migration to one project-state shape yet

## Promotion rules

Promote into Memory only when the result is:
- useful in a future session
- compact enough to scan quickly
- specific enough to source
- better suited to recall than to reopening a long note

Default placement:
- Journal/daily logs -> raw chronology and source material
- Notes -> long-form content and detailed context
- Memory -> compact durable recall
- Ontology -> graph-level concepts and relationships derived from durable signals
- Paperclip -> live execution state, ownership, and closure

Detailed promotion guidance lives in:
- `docs/MEMORY_PROMOTION_RULES.md`
- `docs/MEMORY_SCHEMA_AND_AUDIT_HELPERS.md`

Memory system operation specs live in:
- `docs/FLUSH_TIMING.md` — flush trigger strategy (D3: session-end + pre-compaction flush)
- `docs/FLUSH_QUALITY.md` — flush prompt contract (D4: what to capture, what to skip)
- `docs/CONTEXT_PRUNING.md` — context pruning rules (D5: TTL-based stale tool output pruning)
- `docs/COMPACTION_SURVIVAL.md` — compaction survival contract (D6: behavioral rules, postCompactionSections)
- `docs/TRANSCRIPT_SEARCH.md` — transcript search as first-class capability (D7)
- `docs/WATCHDOG_SAFETY.md` — watchdog safety contract and budget constraints (D8)

## Quick start

```bash
# Human-readable audit
node jarvos-memory/scripts/audit-memory.js

# Machine-readable audit
node jarvos-memory/scripts/audit-memory.js --json
```

The audit currently checks:
- `MEMORY.md` exists
- `memory/decisions/`, `memory/lessons/`, and `memory/projects/` exist
- decision and lesson records have required frontmatter + provenance
- decision and lesson filenames match `YYYY-MM-DD-slug.md`
- project-state entries under `memory/projects/` use an accepted bootstrap shape

## Layout

```text
jarvos-memory/
├── package.json
├── README.md
├── docs/
│   ├── JARVOS_MEMORY_BOOTSTRAP_DECISION_2026-03-25.md
│   ├── MEMORY_PROMOTION_RULES.md
│   ├── MEMORY_SCHEMA_AND_AUDIT_HELPERS.md
│   ├── FLUSH_TIMING.md           ← D3: flush trigger strategy
│   ├── FLUSH_QUALITY.md          ← D4: flush prompt contract
│   ├── CONTEXT_PRUNING.md        ← D5: context pruning rules
│   ├── COMPACTION_SURVIVAL.md    ← D6: compaction survival contract
│   ├── TRANSCRIPT_SEARCH.md      ← D7: transcript search (first-class)
│   ├── WATCHDOG_SAFETY.md        ← D8: watchdog safety contract
│   ├── EXPERIENCE_MEMORY_AGENTMEMORY_CONTRACT.md
│   │                              ← agentmemory sidecar adapter contract
│   └── STACK_MAP.md              ← memory stack map and boundary guide
├── scripts/
│   └── audit-memory.js
└── src/
    ├── index.js
    └── lib/
        ├── audit-memory.js
        ├── memory-config.js
        └── memory-schema.js
```

## Current scope boundary

This is a **module definition and tooling pass**, not a runtime migration.

Out of scope for this bootstrap:
- changing the actual `MEMORY.md` format
- changing the existing `memory/` directory structure
- moving Journal or Notes content into a new runtime system
- replacing OpenClaw compaction or `lossless-claw`
