# claw-secondbrain Monorepo Bootstrap Checklist (2026-03-25)

Umbrella issue: SUP-333

Purpose: define the **minimum** sequence needed to make the monorepo plan executable
without broad refactors or premature package extraction.

## Done already

- umbrella architecture spec drafted in `docs/architecture/claw-secondbrain-monorepo-spec.md`
- umbrella decision restated in `docs/openclaw/CLAW_SECONDBRAIN_MONOREPO_ARCHITECTURE_DECISION_2026-03-25.md`
- Notes package contract published in `docs/openclaw/CLAW_SECONDBRAIN_NOTES_PACKAGE_DECISION_2026-03-25.md`
- Journal package contract published in `docs/openclaw/CLAW_SECONDBRAIN_JOURNAL_PACKAGE_DECISION_2026-03-25.md`
- Memory package contract published in `docs/openclaw/CLAW_SECONDBRAIN_MEMORY_PACKAGE_DECISION_2026-03-25.md`
- current artifacts classified in `docs/contracts/CLAW_SECONDBRAIN_PACKAGE_MAP_2026-03-25.md`

## Minimum next sequence

### 1. Bootstrap the real repo skeleton

Create the empty target layout only:

- `packages/claw-secondbrain-journal/`
- `packages/claw-secondbrain-notes/`
- `packages/claw-secondbrain-memory/`
- `bridge/paperclip/`
- `bridge/provenance/`
- `bridge/routing/`
- `adapters/openclaw/`
- `adapters/obsidian/`

No behavior change required yet.

### 2. Lift package docs before moving logic

Copy or move the package decision docs into package-local `docs/` folders so each package
has its own contract beside future code.

### 3. Extract only the cleanest package-owned implementations first

Lowest-risk first moves:

- Journal:
  - `config/journal-module.json`
  - `scripts/journal-maintenance.js`
- Notes:
  - `scripts/lobster-utils/write-to-vault.js`
  - note contract migration utilities
- Memory:
  - initial memory schema docs / helpers only

Avoid moving Paperclip bridge code in this pass.

### 4. Keep bridge code out of package cores from day one

Hold these separately:

- `journal-note-audit.js`
- `link-to-journal.js`
- `journal-paperclip-inbox.js`
- Paperclip API / feed / PR bridge scripts

That prevents package boundaries from re-blurring during extraction.

### 5. Freeze compatibility surfaces

Until replacement paths exist:

- keep `journal-task-sync.js` explicitly compatibility-only
- keep `memory/YYYY-MM-DD.md` as an input surface, not proof that Memory owns chronology
- keep runtime compaction config documented as adapter wiring, not package core

## Proposed follow-on issues

These should be the next concrete implementation issues after SUP-333 / 247 / 262 / 264
contracts are locked.

1. **Monorepo skeleton bootstrap**
   - create the actual `claw-secondbrain/` folder layout with package/bridge/adapter docs
   - no logic migration yet

2. **Journal package extraction: config + maintenance**
   - move journal contract/config and daily creation logic into package-owned locations
   - keep integrations stubbed or wired through adapters

3. **Notes package extraction: canonical writer + schema lint**
   - likely folds naturally into existing SUP-248 follow-through

4. **Memory package bootstrap: schema + provenance audit helpers**
   - start with class metadata and lightweight validation rather than a large rewrite

5. **Bridge extraction: provenance helpers**
   - move note↔journal linking/audit logic into a bridge area with explicit tests

6. **Bridge extraction: Paperclip reflection/promotion**
   - keep execution authority in Paperclip while making bridge boundaries explicit

## Boundary ambiguities to keep explicit

### 1. `memory/YYYY-MM-DD.md` versus Journal

This is the biggest current naming mismatch.

Recommendation:
- treat these as current operational inputs / compatibility artifacts
- do not let them redefine the target package boundary
- resolve by migration plan, not by pretending they are already the Journal package

### 2. `journal-task-sync.js`

This script still reflects an older model where the journal carried more task state than
it should.

Recommendation:
- keep it running only as needed for compatibility
- do not treat it as a package contract source
- replace with bounded Paperclip reflection over time

### 3. Runtime memory versus durable memory

OpenClaw runtime compaction, `lossless-claw`, and memory retrieval tooling are adjacent to
Memory, but they are not the same thing.

Recommendation:
- document them under adapters
- let the Memory package stay durable, compact, and auditable

### 4. Ontology adjacency

Ontology clearly touches journal/memory outputs, but it should not be forced into the
first monorepo extraction pass.

Recommendation:
- keep ontology out of the initial package split
- add it later only if it earns a stable boundary

## Success condition for this bootstrap phase

This phase is successful when:
- package boundaries are explicit enough to extract code without re-debating ownership
- the first repo skeleton can be created with low risk
- package-owned logic and bridge-owned logic are not mixed in the next implementation pass
- Paperclip remains the execution authority throughout
