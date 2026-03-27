# jarvOS Modules

The three core modules that make jarvOS work. Each module is a standalone npm package
with a clear boundary and a dedicated README.

| Module | Purpose |
|---|---|
| [`@jarvos/memory`](./jarvos-memory/) | Agent-state memory — compact recall across sessions |
| [`@jarvos/ontology`](./jarvos-ontology/) | Worldview layer — beliefs, goals, values, predictions |
| [`@jarvos/secondbrain`](./jarvos-secondbrain/) | Content layer — journal and notes |

## Architecture

```
Raw capture (journal/notes)
  → @jarvos/secondbrain (content layer)
    → @jarvos/memory (compact retained state)
      → @jarvos/ontology (worldview / belief graph)
        → Paperclip (live execution tracking)
```

## Quick Install

```bash
# From the root of this repo
npm install ./modules/jarvos-memory ./modules/jarvos-ontology ./modules/jarvos-secondbrain
```

Or reference each module directly in your project:

```bash
npm install github:levineam/jarvOS#main:modules/jarvos-memory
```

## Module Boundaries

Each module owns a distinct layer. **Do not use them interchangeably.**

| Layer | Module | Typical content |
|---|---|---|
| Content | `@jarvos/secondbrain` | Journal entries, notes, raw capture |
| Recall | `@jarvos/memory` | Lessons, decisions, preferences, facts |
| Worldview | `@jarvos/ontology` | Beliefs, goals, values, predictions |
| Execution | Paperclip | Tasks, issues, assignments, done/not-done |

## Smoke Test

Run `npm test` from the repo root, or:

```bash
node tests/modules-smoke-test.js
```
