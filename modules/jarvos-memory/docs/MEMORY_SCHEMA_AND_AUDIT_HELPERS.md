# Memory Schema and Audit Helpers

Bootstrap schema surface for `jarvos-memory`.

This document defines the first JarvOS-level schema surface for durable agent memory and
explains what the bootstrap audit validates today.

## Goals

- move Memory ownership out of `jarvos-secondbrain` and up to the JarvOS layer
- make the core memory classes explicit
- keep durable memory compact, agent-facing, and auditable
- document `memory/projects/` as part of the memory surface without forcing a structure change
- keep Journal/Notes as content inputs rather than the durable memory registry

## Schema version

- `0.2.0-bootstrap`

## Core memory classes

| Class | Purpose | Current storage mode | Current canonical home |
| --- | --- | --- | --- |
| `fact` | Stable factual context worth reusing later | curated registry entry | `MEMORY.md` |
| `preference` | User or agent preference that changes future decisions | curated registry entry | `MEMORY.md` |
| `decision` | Durable decision with rationale or consequence worth preserving | record-backed markdown file | `memory/decisions/*.md` |
| `project-state` | Compact snapshot of meaningful current project state | project-surface entry | `memory/projects/` |
| `lesson` | Failure pattern, correction, or reusable operating rule | record-backed markdown file | `memory/lessons/*.md` |

## Canonical memory surfaces

Current JarvOS-level durable memory surfaces:
- `MEMORY.md`
- `memory/decisions/*.md`
- `memory/lessons/*.md`
- `memory/projects/`

These are the current nucleus because they already hold compact, durable,
human-auditable memory artifacts or the directory surface that should hold them.

## Project-state bootstrap rule

`memory/projects/` is part of the canonical memory surface now, but the bootstrap does not
force one internal project-state representation yet.

Accepted bootstrap shapes:
- `memory/projects/<slug>.md`
- `memory/projects/<slug>/`

This preserves the current workspace reality while making the directory itself part of the
memory contract.

## Explicit exclusions

These surfaces may feed memory promotion, but they are **not** the canonical memory registry:
- `memory/YYYY-MM-DD.md`
  - daily journal / operating logs
  - source material for promotion into durable memory
- long-form notes and architecture docs
- runtime transcript compaction outputs
- `lossless-claw` summaries / context-engine state
- live Paperclip task state

## Record-backed metadata convention

For markdown-file records such as decisions and lessons, the initial required frontmatter is:
- `class`
- `created`
- `status`
- at least one provenance field

### Allowed `class` values for record-backed files

- `decision`
- `lesson`

### Allowed `status` values

- `active`
- `superseded`
- `corrected`
- `archived`
- `abandoned`

### Accepted provenance fields

At least one of these must be present and non-empty:
- `related`
- `source`
- `sources`
- `provenance`
- `issue`
- `issues`
- `journal`
- `session`
- `transcript`

The provenance requirement stays intentionally light for bootstrap so current durable memory
artifacts remain valid while source traceability becomes explicit.

## Curated-registry classes

These classes currently live in `MEMORY.md` rather than file-per-record surfaces:
- `fact`
- `preference`

## Project-surface class

`project-state` is now explicitly part of the schema surface, but this bootstrap only
requires that the `memory/projects/` container exists and that any entries under it use an
accepted shape. A deeper project-state schema can come later without changing class names.

## Audit helper

CLI:

```bash
node jarvos-memory/scripts/audit-memory.js
node jarvos-memory/scripts/audit-memory.js --json
```

What it audits now:
- `MEMORY.md` exists as part of the canonical nucleus
- `memory/decisions/`, `memory/lessons/`, and `memory/projects/` directories exist
- `memory/decisions/*.md` records have required fields and provenance
- `memory/lessons/*.md` records have required fields and provenance
- record-backed filenames match `YYYY-MM-DD-slug.md`
- project-state entries under `memory/projects/` are directories or markdown files

What it intentionally does **not** audit as canonical durable-memory records yet:
- `memory/YYYY-MM-DD.md`
- OpenClaw runtime compaction state
- `lossless-claw` config or summary outputs
- detailed project-state file contents inside `memory/projects/`

## Why this stays intentionally small

This bootstrap is meant to make the JarvOS Memory module executable enough for future
extraction and integration without collapsing Memory into Journal, Notes, or runtime
compaction.

It adds:
- a shared class vocabulary
- explicit `memory/projects/` coverage
- lightweight provenance expectations
- a concrete audit entrypoint

It does **not** attempt to redesign storage, move all files, or replace current memory
workflows in one shot.
