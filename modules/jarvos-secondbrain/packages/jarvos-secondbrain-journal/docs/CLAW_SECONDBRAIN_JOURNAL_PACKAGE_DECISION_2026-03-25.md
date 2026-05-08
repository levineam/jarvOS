# claw-secondbrain-journal Package Decision (2026-03-25)

Issue: SUP-262

Related issues:
- SUP-333 — monorepo architecture and package boundaries
- SUP-247 — `claw-secondbrain-notes` package architecture and toolchain
- SUP-264 — `claw-secondbrain-memory` package plan
- SUP-286 — Paperclip inbox journal visibility
- SUP-107 — secondbrain / Paperclip separation dogfood assessment

## Decision summary

`claw-secondbrain-journal` is the package that owns chronological intake for the
`claw-secondbrain` monorepo.

Its job is to make day-scoped context:
- easy to capture under uncertainty
- readable to Andrew first
- structurally stable for automation
- linkable outward to durable notes, compact memory, and meaningful Paperclip events

This package should own:
- the canonical daily journal structure
- daily entry creation and repair
- section-level write rules
- resilience expectations for journal upkeep
- day-level links to notes and memory candidates
- bounded reflection of meaningful Paperclip events into the day log

This package should **not** own:
- the durable standalone note contract
- compact durable memory retention policy
- Paperclip execution status or queue authority
- ontology state as a separate domain model
- OpenClaw runtime compaction internals

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
  - lightweight reflection
  - capture before certainty
- `claw-secondbrain-notes`
  - durable standalone knowledge artifacts
  - architecture docs, research, decisions, references
- `claw-secondbrain-memory`
  - compact durable recall
  - promotion/update/invalidation rules
- umbrella / bridge layer
  - routing across packages
  - provenance and linking
  - promotion into Paperclip when captured context becomes tracked execution work

This issue defines the Journal package specifically. SUP-333 remains the umbrella issue
that locks the monorepo map and bridge responsibilities.

## Design principles

1. Journal is the default intake surface when the long-term home is still unclear.
2. Readability for Andrew beats automation cleverness.
3. Structure should be stable enough for scripts, but light enough for humans.
4. Paperclip visibility in the journal is awareness-only, not execution authority.
5. Journal should link out to Notes and Memory rather than absorbing them.

## Canonical journal contract

### Canonical location and shape

Current working shape is defined by `config/journal-module.json` and written into the
Vault journal directory (resolved via `JARVOS_JOURNAL_DIR` env var, or `vault.journalDir` in `config/journal-module.json`, defaulting to `~/Documents/Vault v3/Journal`).

The package contract should preserve that model:
- one Markdown file per day
- date-keyed filename (`YYYY-MM-DD.md`)
- lightweight frontmatter
- fixed required sections
- enabled optional sections driven by config
- automatic structure repair when drift is detected

### Required frontmatter

Current required frontmatter from `config/journal-module.json`:

```yaml
---
journal: Journal
journal-date: YYYY-MM-DD
---
```

Additional fields are allowed, but the default contract should stay small.

### Required sections

Current required sections are:
- `## 🎯 Priorities`
- `## 📅 Today's Calendar`
- `## 📝 Notes`
- `## 💡 Ideas`
- `## 📓 Journal Entry`

Current enabled optional sections are:
- `## 🔔 Apple Reminders`
- `## 📎 Paperclip Inbox`

### Contract rules

- Required sections must always exist.
- Optional sections must follow config-driven enablement.
- Section order should match config.
- Unknown sections should be surfaced for migration, not silently deleted.
- Legacy task sections should not return as a canonical part of the journal contract.

## Automation triggers and resilience expectations

### Creation / maintenance triggers

Journal maintenance should happen through two paths:

1. **Primary operating path**
   - OpenClaw heartbeat / maintenance loop reads `config/journal-module.json`
   - ensures today exists
   - enforces required section structure
   - populates supported dynamic sections

2. **Resilience path**
   - `scripts/journal-maintenance.js`
   - keeps daily creation + minimum population working even if heartbeat orchestration is degraded

### Required resilience expectations

The Journal package should remain functional when:
- heartbeat orchestration is unavailable
- one dynamic section fetcher fails
- Paperclip is temporarily unavailable
- calendar/reminder providers time out

Failure mode rule:
- a failed integration should degrade a section gracefully
- it should not prevent the journal file from existing or being readable

### Existing integrity tooling

- `scripts/journal-note-audit.js`
  - audits whether notes created/updated for a day are linked back into the journal
- `scripts/lobster-utils/link-to-journal.js`
  - lightweight helper for inserting note backlinks into the current day's entry

These are part of the Journal ecosystem, but they are really **bridge/provenance helpers**
more than core journal-schema ownership.

## Role split: Journal vs Notes vs Memory vs Ontology vs Paperclip

### `claw-secondbrain-journal`

Use Journal for:
- what happened today
- rough capture before categorization is certain
- day-scoped updates and observations
- daily reflection and narrative
- outward links to notes created that day
- awareness snapshots of meaningful external state

### `claw-secondbrain-notes`

Use Notes for:
- durable architecture notes
- research writeups
- decision records that should stand outside a single day
- project context worth revisiting later

Notes are durable artifacts; Journal is the day index and intake surface.

### `claw-secondbrain-memory`

Use Memory for:
- compact durable facts
- preferences
- lessons and corrections
- project state snapshots worth compact recall

Memory is the retained compact layer, not the raw daily log.

### Ontology

Ontology is adjacent but distinct.

Beliefs, mission structure, goals, and prediction graphs may be extracted from journal
content, but that domain should not be collapsed into the Journal package contract.

### Paperclip

Paperclip owns:
- assignment
- execution status
- ownership
- done/not-done state
- closeout evidence

Journal may show awareness and meaningful reflections from Paperclip, but it must not
become the canonical task tracker.

## Current-state package map inside `clawd`

| Current artifact | Best target home | Why |
| --- | --- | --- |
| `config/journal-module.json` | `packages/claw-secondbrain-journal/` | This is the canonical daily structure contract already. |
| `scripts/journal-maintenance.js` | `packages/claw-secondbrain-journal/` | Core creation/repair logic for the journal itself. |
| `scripts/lobster-utils/link-to-journal.js` | `bridge/provenance/` | Shared helper that links note artifacts back into daily chronology. |
| `scripts/journal-note-audit.js` | `bridge/provenance/` | Audits cross-package link integrity, not just journal schema. |
| `scripts/journal-paperclip-inbox.js` | `bridge/paperclip/` | Read-only Paperclip projection into the journal. |
| `references/heartbeat-procedures.md` (Section 5) | `adapters/openclaw/` | Operational wiring for OpenClaw heartbeat, not the pure package contract. |
| `scripts/journal-task-sync.js` | compatibility / migration | Still carries legacy `## ✅ Tasks` behavior and should not define the future package boundary. |
| `$JARVOS_JOURNAL_DIR` (default: `~/Documents/Vault v3/Journal/`) | package data surface | Real working journal artifact store. |

## Implementation / cleanup plan

### Minimum package-contract sequence

1. Treat `config/journal-module.json` as the current Journal package contract source.
2. Treat `journal-maintenance.js` as the current reference implementation for creation + repair.
3. Keep `journal-paperclip-inbox.js` explicitly outside the core package boundary as a Paperclip bridge.
4. Freeze `journal-task-sync.js` as compatibility-only until a clean journal reflection path replaces it.
5. Defer repo moves/refactors until the monorepo skeleton exists.

### What should happen next

- move the journal contract/config into the eventual package layout
- extract a clear journal API surface (create day, repair day, populate sections)
- replace legacy task mirroring with bounded Paperclip reflection rules
- add interoperability tests for journal ↔ notes backlinks and journal ↔ Paperclip reflections

## Success metrics

The Journal package architecture is working when:

### Contract metrics
- today's journal can be created from package-defined config alone
- section drift is repaired consistently
- optional sections remain config-driven rather than hardcoded across many scripts

### Boundary metrics
- journal remains clearly distinct from durable notes and compact memory
- Paperclip inbox / reflections are documented as projections, not execution authority
- legacy task mirroring stops defining the package contract

### Resilience metrics
- journal creation still works when heartbeat orchestration is down
- failed integrations degrade gracefully to readable placeholders
- note backlink gaps are auditable and fixable

## References

- `docs/architecture/claw-secondbrain-monorepo-spec.md`
- `docs/openclaw/CLAW_SECONDBRAIN_MONOREPO_ARCHITECTURE_DECISION_2026-03-25.md`
- `docs/openclaw/CLAW_SECONDBRAIN_NOTES_PACKAGE_DECISION_2026-03-25.md`
- `config/journal-module.json`
- `references/heartbeat-procedures.md`
- `memory/2026-03-22-sup107-dogfood-assessment.md`
