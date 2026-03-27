# jarvos-memory Bootstrap Decision (2026-03-25)

## Decision

Bootstrap `jarvos-memory` as a standalone JarvOS-level module rather than keeping durable
Memory inside `jarvos-secondbrain/packages/jarvos-memory (at JarvOS level)`.

## Why

The architecture pivot on 2026-03-25 clarified that Memory is primarily **agent state**:
compact retained recall that helps Jarvis and other agents operate across sessions.

That makes Memory a JarvOS concern, not a secondbrain content package.

## Boundary model

### `jarvos-memory`
Owns:
- durable memory classes
- promotion rules
- provenance expectations
- audit / validation helpers
- the canonical working memory surfaces in `clawd/`

### `jarvos-secondbrain`
Owns content-facing systems:
- Journal / chronology
- Notes / long-form source material
- content retrieval and adapter boundaries

### `jarvos-ontology`
Owns the structured worldview graph:
- beliefs
- predictions
- goals
- projects
- relationships

## Current canonical working surfaces

During bootstrap, `jarvos-memory` owns these surfaces conceptually:
- `MEMORY.md`
- `memory/decisions/`
- `memory/lessons/`
- `memory/projects/`

This is a contract move and tooling move, not a runtime storage migration.

## Migration note

The earlier `jarvos-memory (at JarvOS level)` package remains a useful reference source for the
bootstrap helper code and docs, but the canonical home for future Memory work is now
`jarvos-memory/`.
