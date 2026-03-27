# @jarvos/memory

Agent-state memory module for jarvOS. Provides compact recall that helps your AI agent
persist knowledge across sessions without turning Memory into a second content store.

## What this module owns

- Stable **facts** worth reusing later
- **Preferences** that change future decisions
- Durable **decisions** with rationale
- **Lessons** and corrections
- **Project-state** snapshots worth carrying across days

## What this module is NOT for

| Use this instead | For |
|---|---|
| `@jarvos/secondbrain` | Day-by-day journal and raw capture |
| `@jarvos/ontology` | Structured worldview (beliefs, goals, values) |
| Paperclip | Live task tracking and execution state |

More detail on boundaries:

### vs. `jarvos-secondbrain`

`jarvos-secondbrain` is the **content-facing** layer:

- Journal = day-by-day chronology and raw capture
- Notes = longer-form research, architecture, and source material

`jarvos-memory` is the **agent-facing** layer:

- compact retained state
- promotion rules
- provenance expectations
- lightweight audits

### vs. `jarvos-ontology`

`jarvos-ontology` is the worldview / graph layer.

Integration rule:

- Memory keeps compact retained state.
- Ontology turns the most important durable signals into structured beliefs, goals,
  projects, and relationships.
- Not every memory becomes ontology, but ontology should be informed by durable memory.

## Quick Start

```bash
npm install ./modules/jarvos-memory
```

```js
const { createMemoryRecord, getMemoryClasses } = require('@jarvos/memory');

// Create a durable memory
const result = createMemoryRecord({
  class: 'lesson',
  content: 'Prefer env-var path resolution over hardcoded home directories.',
  rationale: 'Enables portability across machines and CI environments.',
  source: '2026-03-27',
  confidence: 0.95,
});

console.log(result.record); // { class: 'lesson', content: '...', id: '...', ... }

// List available memory classes
console.log(getMemoryClasses()); // ['fact', 'preference', 'decision', 'lesson', 'project-state']
```

Or use the audit CLI directly:

```bash
cd modules/jarvos-memory
npm install
node scripts/audit-memory.js --help
```

## Memory Schema

```json
{
  "schema": "jarvos-memory/v1",
  "class": "lesson",
  "content": "Compact human-readable statement.",
  "rationale": "Why this matters.",
  "source": "2026-03-27",
  "confidence": 0.9,
  "id": "abc123",
  "createdAt": "2026-03-27T00:00:00.000Z"
}
```

## Promotion Rules

Promote into Memory only when the result is:

- Useful in a future session
- Compact enough to scan quickly
- Specific enough to source
- Better suited to recall than reopening a long note

Default routing:

- Journal/daily logs → raw chronology and source material
- Notes → long-form content and detailed context
- Memory → compact durable recall
- Ontology → graph-level concepts and relationships derived from durable signals
- Paperclip → live execution state, ownership, and closure

Detailed promotion guidance lives in:

- `docs/MEMORY_PROMOTION_RULES.md`
- `docs/MEMORY_SCHEMA_AND_AUDIT_HELPERS.md`

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

## Memory system operation specs

- `docs/FLUSH_TIMING.md` — flush trigger strategy (D3: session-end + pre-compaction flush)
- `docs/FLUSH_QUALITY.md` — flush prompt contract (D4: what to capture, what to skip)
- `docs/CONTEXT_PRUNING.md` — context pruning rules (D5: TTL-based stale tool output pruning)
- `docs/COMPACTION_SURVIVAL.md` — compaction survival contract (D6: behavioral rules, postCompactionSections)
- `docs/TRANSCRIPT_SEARCH.md` — transcript search as first-class capability (D7)
- `docs/WATCHDOG_SAFETY.md` — watchdog safety contract and budget constraints (D8)

## Layout

```text
jarvos-memory/
├── package.json
├── README.md
├── docs/
│   ├── JARVOS_MEMORY_BOOTSTRAP_DECISION_2026-03-25.md
│   ├── MEMORY_PROMOTION_RULES.md
│   ├── MEMORY_SCHEMA_AND_AUDIT_HELPERS.md
│   ├── FLUSH_TIMING.md
│   ├── FLUSH_QUALITY.md
│   ├── CONTEXT_PRUNING.md
│   ├── COMPACTION_SURVIVAL.md
│   ├── TRANSCRIPT_SEARCH.md
│   └── WATCHDOG_SAFETY.md
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
