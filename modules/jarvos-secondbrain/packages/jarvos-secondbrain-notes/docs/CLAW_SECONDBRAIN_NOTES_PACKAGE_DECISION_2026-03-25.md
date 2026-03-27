# claw-secondbrain-notes Package Decision (2026-03-25)

Issue: SUP-247

Related issues:
- SUP-333 — monorepo architecture and package boundaries
- SUP-248 — canonical writer + schema lint
- SUP-249 — existing note normalization / migration
- SUP-250 — retrieval stack benchmark + convergence
- SUP-262 — `claw-secondbrain-journal` package plan
- SUP-264 — `claw-secondbrain-memory` package plan

## Decision summary

`claw-secondbrain-notes` is the package that owns the durable note contract for the
`claw-secondbrain` monorepo.

Its job is to make durable notes:
- portable
- retrieval-friendly
- easy to write through automation
- clearly distinct from journal intake, compact memory, and runtime conversation recall

This package should own:
- the canonical note contract
- the canonical automated writer path for notes
- note-schema validation rules
- note migration rules for legacy durable notes
- note-oriented retrieval conventions

This package should **not** own:
- daily chronological intake
- compact long-term memory selection/promotion
- OpenClaw runtime compaction internals
- Paperclip execution state

## Where this fits in the monorepo

Recommended package map:

```text
claw-secondbrain/
  packages/
    claw-secondbrain-journal/
    claw-secondbrain-notes/
    claw-secondbrain-memory/
  bridge/
    paperclip/
    provenance/
    routing/
```

### Monorepo role split

- `claw-secondbrain-journal`
  - chronological intake
  - daily structure
  - links back to what happened and when
- `claw-secondbrain-notes`
  - durable standalone knowledge artifacts
  - architecture notes, research notes, decision records, project briefs, references
- `claw-secondbrain-memory`
  - compact durable memory objects and promotion/update rules
  - facts/preferences/decisions that should stay short and maintainable
- umbrella / bridge layer
  - routing logic between packages
  - provenance and linking
  - promotion into Paperclip when captured context becomes execution work

This issue defines the Notes package specifically. SUP-333 remains the umbrella issue that
locks the full monorepo boundary and folder structure.

## Design principles

1. Portable Markdown first.
2. Retrieval clarity over ornamental structure.
3. One canonical write path for automated note creation.
4. Separate note storage from retrieval from memory promotion from runtime continuity.
5. Keep the package Obsidian-optional and CLI-friendly.

## Toolchain keep/adopt/reject matrix

| Tool | Decision | Role in `claw-secondbrain-notes` | Why |
| --- | --- | --- | --- |
| QMD | **Keep** | Primary local note retrieval engine | Strong for local Markdown search and hybrid retrieval without redefining the note format. |
| `markdownlint` | **Adopt** | Structural Markdown lint | Good for headings, spacing, and list/code-fence hygiene, but not for frontmatter semantics. |
| Vale | **Adopt (optional)** | Prose/style lint | Useful where writing quality matters, but should stay advisory rather than becoming the schema authority. |
| Marksman | **Keep (editor-side only)** | Editor assistance | Helpful for links and authoring, but not a required runtime dependency. |
| Obsidian Linter | **Reject for core automation** | Optional manual cleanup only | Fine inside Obsidian, but the package contract must not depend on GUI plugins. |
| `obsidian-cli` | **Keep** | Auxiliary note operations | Useful for targeted CRUD/search flows, but not the canonical writer contract. |
| Custom writer (`scripts/lobster-utils/write-to-vault.js`) | **Adopt** | Canonical automation writer path | Already the closest thing to a standard automation path; SUP-248 should harden it into the actual contract owner. |

## Canonical note contract

### Required frontmatter

All durable notes in `Notes/*.md` should converge on this minimum contract:

```yaml
---
status: active
type: project-note
project: ""
created: YYYY-MM-DD
updated: YYYY-MM-DD
author: jarvis
---
```

### Required fields

| Field | Type | Allowed values / rule | Purpose |
| --- | --- | --- | --- |
| `status` | enum | `active` \| `draft` \| `archived` \| `abandoned` | lifecycle / filtering |
| `type` | enum | `project-note` \| `draft` \| `research` \| `decision` \| `reference` \| `article` \| `chapter` | retrieval and processing class |
| `project` | string | empty string allowed | stable project/topic grouping |
| `created` | date | `YYYY-MM-DD` | creation date |
| `updated` | date | `YYYY-MM-DD` | last substantive update |
| `author` | enum | `jarvis` \| `andrew` \| `both` | provenance |

### Contract rules

- Additional frontmatter fields are allowed.
- `project` may be empty when the note is intentionally unscoped.
- `created` should be preserved once set.
- `updated` should refresh on substantive automated rewrites.
- The contract must stay plain YAML + Markdown, not an Obsidian-only construct.

### Recommended body shape

Body structure should be guided, not ritualized.

```md
# Title

## Summary
Short statement of what this note is and why it matters.

## Details
Main content, findings, analysis, or working notes.

## Links
Related notes, issues, sources, or follow-on work.
```

Optional sections when they fit:
- `## Decision`
- `## Open Questions`
- `## Next Actions`
- `## Sources`
- `## Context`

The default rule is: enough structure to help retrieval and reuse, not so much structure
that agents or humans avoid writing notes.

## Role split: Notes vs Journal vs Memory vs retrieval vs lossless-claw

### `claw-secondbrain-notes`

Notes are the durable standalone knowledge layer.

Use Notes for:
- architecture docs
- research writeups
- durable project notes
- decision records
- references worth revisiting later
- substantial subagent output that should stand on its own

Notes should be readable outside the exact day they were created.

### `claw-secondbrain-journal`

Journal is the chronological intake layer.

Use Journal for:
- what happened today
- lightweight updates
- rough capture when the right long-term home is still unclear
- links outward to notes created that day

Journal is day-ordered context, not the durable-note registry.

### `claw-secondbrain-memory`

Memory is the compact durable memory layer.

Use Memory for:
- stable facts worth retaining
- preferences
- durable decisions that need compact recall
- curated abstractions promoted from Journal/Notes/transcripts

Memory should stay smaller and more distilled than Notes.

### Retrieval layer

Retrieval is the discovery path, not the note schema source of truth.

Operational split:
- `memory_search` = default in-agent recall path
- `qmd search` = default shell lookup for note discovery
- `qmd get` = exact note retrieval after search

QMD/OpenClaw retrieval should index and discover notes, but it should not own the note
contract.

### `lossless-claw`

`lossless-claw` is the conversation continuity layer.

Use it for:
- long chat history preservation
- compacted conversation recall
- summary/DAG-based expansion over prior sessions

It should **not** define note structure or become the durable note store.

## Package boundaries and integration contracts

### What `claw-secondbrain-notes` should expose

At the package boundary, Notes should eventually expose:
- note creation/write helpers
- note-schema validation
- note migration utilities
- note retrieval conventions and docs
- note provenance/linking helpers where needed

### What it should consume from adjacent layers

- from Journal:
  - links back to originating days/entries
  - rough intake promoted into durable notes
- from Memory:
  - selective promotion candidates distilled from notes
- from the umbrella bridge layer:
  - routing/provenance rules
  - Paperclip promotion criteria when a note implies tracked execution work

### What stays outside the package

- journal automation scheduling
- memory decay/invalidation logic
- OpenClaw runtime compaction internals
- Paperclip queue ownership and task state

## Relationship to Paperclip

The boundary remains:
- `claw-secondbrain` packages = capture, preserve, organize, relate, distill
- Paperclip = commit, assign, execute, track, close

Notes may contain execution-relevant context, but they should not become a shadow task
tracker.

## Follow-on implementation map

### Package-level follow-ons

- **SUP-248** — harden the canonical writer and schema lint path
- **SUP-249** — normalize legacy durable notes to the package contract
- **SUP-250** — keep retrieval guidance aligned with the live QMD/OpenClaw split

### Umbrella alignment

- **SUP-333** — lock the full monorepo architecture and package boundaries
- **SUP-262** — define the Journal package in the same language
- **SUP-264** — define the Memory package in the same language

## Recommended implementation order

From the current state, the cleanest path is:

1. Use **SUP-333** to lock the umbrella package map and integration boundary.
2. Use **SUP-247** to lock the Notes package contract and role split.
3. Use **SUP-248** to enforce the write/validation path for new notes.
4. Use **SUP-249** to migrate the legacy note corpus safely.
5. Keep **SUP-250** as the retrieval operating decision that supports the package.
6. Align **SUP-262** and **SUP-264** so Journal and Memory use the same boundary language.

## Success metrics

The Notes package architecture is working when:

### Contract metrics
- new automated note writes conform to the required frontmatter contract
- the canonical writer path is explicit and reused
- schema drift is caught by validation instead of discovered ad hoc

### Boundary metrics
- durable notes are clearly distinct from journal entries and compact memory
- lossless-claw is documented only as a continuity layer
- Paperclip remains the system of record for execution state

### Retrieval metrics
- agents have one clear default in-chat recall path and one clear shell search path
- retrieval docs match live QMD/OpenClaw behavior
- note retrieval improves without coupling note schema to the context engine

### Monorepo metrics
- the Notes package definition can snap into the `claw-secondbrain` monorepo without
  redefining Journal or Memory
- package responsibilities remain understandable to future agents

## References

- `docs/openclaw/QMD_RETRIEVAL_STACK_DECISION_2026-03-23.md`
- `$JARVOS_VAULT_NOTES/claw-secondbrain v1 Boundary and Routing Contract.md` (default: `~/Documents/Vault v3/Notes/`)
