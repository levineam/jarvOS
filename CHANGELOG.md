# Changelog

Release sections describe user-facing jarvOS changes. Historical public-doc sync entries are preserved below for traceability.

## [Unreleased]

- Added portable `jarvos-secondbrain-notes` manual note maintenance for
  markdown notes created outside the canonical writer: dry-run audit, explicit
  apply mode, state/audit coverage checks, sensitivity-aware GBrain and
  memory-wiki queue cleanup, QMD freshness records, package bin/exports, docs,
  and focused tests.

## v0.3.0 — 2026-05-22

Public CLI, Doctor, and Obsidian default experience-pack release. Tracked in
SUP-1957 / SUP-1979 / SUP-2056.

### Included
- Added the public `jarvos` command router with discoverable `jarvos init`,
  `jarvos doctor`, and `jarvos help` commands while preserving the existing
  `jarvos-bootstrap` and `jarvos-init` compatibility aliases.
- Added the public `minimal` profile manifest for portable starter workspaces:
  Node.js, core workspace files, `jarvos.config.json`, vault folders, and the
  `@jarvos/agent-context` package surface.
- Added `jarvos doctor --profile minimal` with human-readable and JSON output
  for release-grade starter health checks.
- Added profile-aware `jarvos init --profile minimal` routing so setup and
  doctor use the same public profile model.
- Documented the CLI happy path in the README and included the CLI entrypoint,
  profile files, agent-context package, and skills module in the npm package
  file list.
- Added the `obsidian-default` experience pack to `@jarvos/skills`, referencing
  `kepano/obsidian-skills` commit `553ef99` and covering Obsidian Markdown,
  `obsidian-cli`, Defuddle, JSON Canvas, and Obsidian Bases.
- Added an experience-pack doctor/install-plan surface for optional Obsidian and
  Defuddle command detection while keeping jarvOS Markdown-first.

### Fixes
- Closes the release-readiness gap where new users could run smoke tests but had
  no single public `jarvos` command for setup and health checks.
- Keeps local-only Paperclip, private GBrain data, and future full-profile checks
  outside the minimal public doctor so the public install path stays portable and
  secret-free.
- Keeps Obsidian Bases and Canvas as reading, review, and artifact surfaces
  rather than live project-management or execution-state authorities.

### Known Limitations
- Only the `minimal` public profile is implemented in this release; Codex,
  Claude, Hermes, local OpenClaw, Paperclip, GBrain, and full profiles remain
  future profile lanes.
- `jarvos doctor` validates checked-in public surfaces and local workspace
  structure, not private Paperclip state, private vault content, or a live local
  GBrain graph.
- jarvOS remains GBrain-first: it integrates `@jarvos/gbrain` as a resolver and
  runtime context layer and does not implement GBrain itself; this release is not
  GBrain itself.
- Distribution is still git/npm-from-repo based; no public npm registry package
  is published yet.
- The Obsidian pack is a manifest and install-plan surface in this release; the
  referenced upstream skills are not vendored into the public jarvOS repo.

## v0.2.1 — 2026-05-21

Release-process hardening. Tracked in SUP-1953 (part of the journal-spine reliability set SUP-1938–1942).

### Included
- Adopted a `## [Unreleased]` section in this changelog as the staging area for
  merged-but-unreleased work, so "what has shipped" and "what is merged on main"
  stay distinct.
- Added `npm run release:drift` (`scripts/unreleased-drift-check.js`) to detect
  release drift: a `package.json` version ahead of the latest git tag with no
  finalized changelog section (an untagged release), or commits landed since the
  latest tag with nothing tracked under `## [Unreleased]` (unlogged work).
- Documented the `[Unreleased]` discipline and the drift check in
  `docs/release-process.md`.

### Fixes
- Closes a release-process gap where work merged to `main` could be mistaken for
  a published release because no signal distinguished merged work from a cut tag.

### Known Limitations
- The drift check is advisory maintainer tooling and is intentionally not part of
  `release:check`'s blocking gates.
- jarvOS remains GBrain-first: it integrates `@jarvos/gbrain` as a resolver and
  runtime context layer and does not implement GBrain itself; this release is not
  GBrain itself.
- Distribution is still git/npm-from-repo based; no public npm registry package is
  published yet.

## v0.2.0 — 2026-05-18

Second public release. Tracked in SUP-1737.

### Included
- "Capture Your Thoughts" first-experience flow: high-confidence idea phrases
  land in the journal Ideas section, high-confidence note phrases create
  Obsidian-compatible notes with journal wiki-links, and medium-confidence
  captures route to a Flagged review section instead of creating durable notes
  prematurely (SUP-1804).
- `@jarvos/secondbrain` now exposes the capture classifier, routing dispatcher,
  and portable skill contracts for `journal-entry`, `note-creation`, and
  `idea-parking`; the package includes explicit npm `exports` for the main API,
  routing API, contracts, and config resolver.
- The secondbrain public API now delegates path resolution to the shared
  repo-owned `jarvos.config.json` / `JARVOS_*` resolver instead of keeping a
  separate hardcoded `/clawd`-era fallback.
- Claude Code runtime adapter now bootstraps `~/.claude/CLAUDE.md` from
  `runtimes/claude/templates/CLAUDE.md.template`, giving every fresh Claude
  Code session in a jarvOS workspace a baseline of identity, governance
  pointers, runtime-applicability notes for `CRITICAL-RULES.md`, release
  targeting routing, and proactive upstream-evaluation behavior — not just
  hydration context (SUP-1738).
- Setup script materialization is idempotent and preserves anything added
  below the `<!-- LOCAL-EXTENSIONS-BELOW -->` marker across re-runs; existing
  `~/.claude/CLAUDE.md` files are backed up before any overwrite.
- New environment switches: `JARVOS_SKIP_CLAUDE_MD=1` to skip CLAUDE.md
  materialization and `CLAUDE_MD_PATH` to retarget the destination.

### Fixes

- Added idempotent behavior and local-extension preservation for CLAUDE.md
  materialization (`runtimes/claude/setup.sh`).

### Known Limitations

- CLAUDE.md runtime bootstrap is scoped to Claude Code setup and does not
  currently apply to all local runtimes equally.
- The public repo includes Claude runtime integration code and fixtures, not GBrain itself.
- Distribution remains git-based; no npm package is published for this release.

### Breaking Changes

- None known.

## v0.1.0 — 2026-05-15

First public preview release candidate.

### Included
- Portable jarvOS core files for identity, persona, behavioral rules, and local setup templates.
- Runtime setup paths for Hermes Agent and OpenClaw.
- Claude Desktop manual MCP hydration via the `boot jarvOS` prompt.
- Smoke test coverage for shipped files and public baseline completeness.
- GBrain-first structured recall integration via `@jarvos/gbrain`: curated import planning, GBrain sync/embed wrappers, graph recall, runtime recall bundles, and public eval fixtures.
- Default operating-system skills via `@jarvos/skills`: workflow execution, rule creation, context management, and cron hygiene.
- Release process documentation, GitHub Release template, and executable release readiness check.

### Known limitations
- Distribution is git-based; no npm package is published for this release.
- Setup still expects comfort with local developer tools and runtime-specific configuration.
- Claude Desktop startup auto-hydration is not included; Desktop uses the manual MCP hydration flow.
- Andrew's live private workspace is not included in the public baseline.
- GBrain itself, private generated pages, private manifests, and private eval questions are not included; the repo ships the integration layer and public fixtures only.
- QMD is not bundled as a default skill; it remains an optional markdown-search adapter.

## 2026-03-27 — merged outstanding public repo PRs

### PR #2 — docs: Phase A public hygiene + dogfood canary prep
- merged the CI hygiene improvements and shipped-file clarifications from PR #2
- kept the latest `main`-line sync-generated artifacts while updating the branch so the merge did not reintroduce docs-sync drift

### PR #4 — docs: align public baseline docs and metadata
- aligned the public README/starter-kit messaging with the files actually shipped in this repo
- carried forward the baseline-candidate rollout notes and removed stale PR-autopilot diagnostics from the public repo

### PR #5 — feat: cross-platform jarvOS core + runtime adapters
- added the portable `core/` behavioral layer plus Hermes and OpenClaw runtime adapter docs
- restored the Codex review trigger workflow with auto-commit/docs-sync skip logic
- normalized public export metadata to relative, non-machine-specific source paths

## 2026-02-28 — feat: major update — new templates, patterns, and optional modules

### Phase 1: Updated existing templates
- `templates/agents-template.md` — Replaced "Live Plan" → "Plan" throughout; replaced CE-PROCESS refs with "AGENTS.md § Process"; added Process section (wire first, report, never ask permission); added Do-First rule (HARD); added optional Lobster workflow gates section; added optional context engineering auto-triggers section; bumped to v2.0.0
- `templates/heartbeat-template.md` — Added §6.8 Uncommitted Work Check; added §10 Escalation Ladder format; added §11 Autonomy Levels Policy; updated §6.7 to clarify autonomous work continues 24/7 (quiet hours only affect notifications/nudges); added §7.5 Disk Space Check; added §0 Fast Awareness Gate; fixed section numbering throughout; bumped to v2.0.0

### Phase 2: Added missing templates
- `templates/soul-template.md` — Generic persona template with customization guidance
- `templates/identity-template.md` — Name, creature, emoji, example table
- `templates/tools-template.md` — Slim operational policy template (<2K chars) with sections for spawn policy, model routing, quiet hours, approved acronyms
- `templates/ontology-template.md` — Full Higher Order → Beliefs → Predictions → Core Self → Goals → Portfolios structure with usage notes

### Phase 3: Added new patterns
- `starter-kit/workflows/write-prose.lobster` — Generic humanizer gate; checks 15 AI writing pattern categories; requires score ≥85 and human approval before saving/sending
- `starter-kit/workflows/spawn-code-subagent.lobster` — Generic code quality gate; enforces branch-first, PR-required, test-pass, and review-before-merge discipline
- `docs/optional/jsonl-memory.md` — JSONL memory schema docs (experiences, decisions, failures); clearly marked OPTIONAL with "when to adopt" guidance; includes append discipline, search patterns, and integration notes
- `docs/optional/context-engineering.md` — How to install and configure the ClawHub context engineering skill pack; when to install guidance; auto-trigger setup; key concepts from Koylan framework

### Phase 4: Cleanup
- `README.md` — Reflected all new components; updated template table; added optional modules section; replaced "Live Plan" with "Plan"
- `CHANGELOG.md` — Added this entry
- `starter-kit/readme.md` — Updated to reflect new workflows directory and optional modules

## 2026-02-19 08:38 EST — docs sync
- Updated: docs/architecture/architecture-decision-records/architecture-decision-record-20260219-ars-contexta-patterns.md
- Updated: docs/architecture/jarvos-architecture.md
- Updated: starter-kit/README.md
- Updated: starter-kit/templates/OKR-TASK-BOARD.template.md
- Updated: starter-kit/templates/PROJECT-KICKOFF-PACK.template.md
- Updated: starter-kit/workflows/basic-ci.yml
- Updated: templates/AGENTS-template.md
- Updated: templates/BOOTSTRAP-template.md
- Updated: templates/HEARTBEAT-template.md
- Updated: templates/OKR-TASK-BOARD.template.md
- Updated: templates/PROJECT-KICKOFF-PACK.template.md

## 2026-02-19 08:53 EST — docs sync
- Updated: docs/architecture/architecture-decision-records/architecture-decision-record-20260219-ars-contexta-patterns.md
- Updated: docs/architecture/jarvos-architecture.md

## 2026-02-19 09:08 EST — docs sync
- Updated: docs/architecture/adrs/ADR-20260219-ars-contexta-patterns.md
- Updated: docs/architecture/jarvos-architecture.md
- Updated: docs/architecture/architecture-decision-records/architecture-decision-record-20260219-ars-contexta-patterns.md

## 2026-02-19 09:08 EST — rename note
- Renamed (slugified export path): `docs/architecture/adrs/ADR-20260219-ars-contexta-patterns.md` → `docs/architecture/architecture-decision-records/architecture-decision-record-20260219-ars-contexta-patterns.md`
- Confirmed source vault filename remains unchanged: `Architecture Decision Record - 20260219 - Ars Contexta Patterns.md`

## 2026-02-19 09:49 EST — docs sync
- Updated: docs/architecture/adrs/ADR-20260219-ars-contexta-patterns.md
- Updated: docs/architecture/jarvos-architecture.md
- Updated: starter-kit/templates/OKR-TASK-BOARD.template.md
- Updated: starter-kit/templates/PROJECT-KICKOFF-PACK.template.md
- Updated: templates/AGENTS-template.md
- Updated: templates/OKR-TASK-BOARD.template.md
- Updated: templates/PROJECT-KICKOFF-PACK.template.md
- Updated: docs/architecture/architecture-decision-records/architecture-decision-record-20260219-ars-contexta-patterns.md
- Updated: docs/meta/source-to-export-map.json
- Updated: starter-kit/templates/okr-task-board-template.md
- Updated: starter-kit/templates/project-kickoff-pack-template.md
- Updated: templates/okr-task-board-template.md
- Updated: templates/project-kickoff-pack-template.md

## 2026-02-19 10:54 EST — docs sync
- Updated: docs/architecture/adrs/ADR-20260219-ars-contexta-patterns.md
- Updated: docs/architecture/jarvos-architecture.md
- Updated: starter-kit/templates/OKR-TASK-BOARD.template.md
- Updated: starter-kit/templates/PROJECT-KICKOFF-PACK.template.md
- Updated: templates/AGENTS-template.md
- Updated: templates/OKR-TASK-BOARD.template.md
- Updated: templates/PROJECT-KICKOFF-PACK.template.md
- Updated: docs/architecture/architecture-decision-records/architecture-decision-record-20260219-ars-contexta-patterns.md
- Updated: docs/meta/source-to-export-map.json
- Updated: starter-kit/templates/okr-task-board-template.md
- Updated: starter-kit/templates/project-kickoff-pack-template.md
- Updated: templates/okr-task-board-template.md
- Updated: templates/project-kickoff-pack-template.md

## 2026-02-19 11:07 EST — docs sync
- Updated: docs/architecture/adrs/ADR-20260219-ars-contexta-patterns.md
- Updated: docs/architecture/jarvos-architecture.md
- Updated: starter-kit/templates/OKR-TASK-BOARD.template.md
- Updated: starter-kit/templates/PROJECT-KICKOFF-PACK.template.md
- Updated: templates/AGENTS-template.md
- Updated: templates/OKR-TASK-BOARD.template.md
- Updated: templates/PROJECT-KICKOFF-PACK.template.md
- Updated: docs/architecture/architecture-decision-records/architecture-decision-record-20260219-ars-contexta-patterns.md
- Updated: docs/meta/source-to-export-map.json
- Updated: starter-kit/templates/okr-task-board-template.md
- Updated: starter-kit/templates/project-kickoff-pack-template.md
- Updated: templates/okr-task-board-template.md
- Updated: templates/project-kickoff-pack-template.md

## 2026-02-19 12:07 EST — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-02-19 13:07 EST — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-02-19 14:07 EST — docs sync
- Updated: docs/architecture/architecture-decision-records/architecture-decision-record-20260219-ars-contexta-patterns.md
- Updated: docs/meta/source-to-export-map.json
- Updated: templates/AGENTS-template.md
- Updated: templates/HEARTBEAT-template.md

## 2026-02-19 15:07 EST — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-02-19 16:07 EST — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-02-19 17:07 EST — docs sync
- Updated: docs/meta/source-to-export-map.json
- Updated: templates/AGENTS-template.md
- Updated: templates/HEARTBEAT-template.md

## 2026-02-19 18:07 EST — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-02-19 19:07 EST — docs sync
- Updated: docs/meta/source-to-export-map.json
- Updated: templates/HEARTBEAT-template.md

## 2026-02-19 20:07 EST — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-02-19 21:07 EST — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-02-19 22:07 EST — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-02-19 23:07 EST — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-02-20 00:07 EST — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-02-20 01:07 EST — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-02-20 02:07 EST — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-02-20 03:07 EST — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-02-20 04:07 EST — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-02-20 05:07 EST — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-02-20 06:07 EST — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-02-20 07:07 EST — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-02-20 08:07 EST — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-02-20 09:07 EST — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-02-20 10:07 EST — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-02-20 11:07 EST — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-02-20 13:56 EST — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-02-20 14:07 EST — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-02-20 15:07 EST — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-02-20 16:07 EST — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-02-20 17:07 EST — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-02-20 18:07 EST — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-02-20 19:07 EST — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-02-20 20:07 EST — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-02-20 21:07 EST — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-02-20 22:07 EST — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-02-20 23:07 EST — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-02-21 00:08 EST — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-02-21 01:07 EST — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-02-21 02:07 EST — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-02-21 03:07 EST — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-02-21 04:07 EST — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-02-21 05:07 EST — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-02-21 06:07 EST — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-02-21 07:08 EST — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-02-21 08:07 EST — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-02-21 09:07 EST — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-02-21 10:07 EST — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-02-21 11:07 EST — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-02-21 12:07 EST — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-02-21 13:07 EST — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-02-21 14:07 EST — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-02-21 15:07 EST — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-02-21 16:07 EST — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-02-21 17:07 EST — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-02-21 18:07 EST — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-02-21 19:09 EST — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-02-21 20:07 EST — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-02-21 21:07 EST — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-02-21 22:07 EST — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-02-21 23:07 EST — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-02-22 00:07 EST — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-02-22 01:07 EST — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-02-22 02:07 EST — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-02-22 03:07 EST — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-02-22 04:07 EST — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-02-22 05:07 EST — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-02-22 06:07 EST — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-02-22 07:07 EST — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-02-22 08:07 EST — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-02-22 09:07 EST — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-02-22 10:07 EST — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-02-22 11:07 EST — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-02-22 12:07 EST — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-02-22 13:07 EST — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-02-22 14:07 EST — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-02-22 21:07 EST — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-02-22 22:07 EST — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-02-22 23:07 EST — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-02-23 00:07 EST — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-02-23 01:07 EST — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-02-23 02:07 EST — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-02-23 03:07 EST — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-02-23 06:07 EST — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-02-23 07:07 EST — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-02-23 09:07 EST — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-02-23 10:07 EST — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-02-23 11:07 EST — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-02-23 12:07 EST — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-02-23 13:07 EST — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-02-23 15:07 EST — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-02-23 18:07 EST — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-02-23 19:07 EST — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-02-23 20:07 EST — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-02-23 21:07 EST — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-02-23 22:07 EST — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-02-23 23:07 EST — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-02-24 00:07 EST — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-02-24 02:07 EST — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-02-24 03:07 EST — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-02-24 12:07 EST — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-02-24 13:07 EST — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-02-24 14:07 EST — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-02-24 15:07 EST — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-02-24 16:07 EST — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-02-24 17:07 EST — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-02-24 18:07 EST — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-02-24 19:07 EST — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-02-24 20:07 EST — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-02-24 21:07 EST — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-02-24 22:07 EST — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-02-24 23:07 EST — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-02-25 00:07 EST — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-02-25 01:07 EST — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-02-25 02:07 EST — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-02-25 03:07 EST — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-02-25 04:07 EST — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-02-25 05:07 EST — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-02-25 06:07 EST — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-02-25 07:07 EST — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-02-25 08:07 EST — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-02-25 09:07 EST — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-02-25 10:07 EST — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-02-25 11:07 EST — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-02-25 12:07 EST — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-02-25 13:07 EST — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-02-25 14:07 EST — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-02-25 15:07 EST — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-02-25 16:07 EST — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-02-25 17:07 EST — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-02-25 18:07 EST — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-02-25 19:07 EST — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-02-25 20:07 EST — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-02-25 21:07 EST — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-02-25 22:07 EST — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-02-25 23:07 EST — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-02-26 00:07 EST — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-02-26 01:07 EST — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-02-26 02:07 EST — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-02-26 03:07 EST — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-02-26 04:07 EST — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-02-26 05:07 EST — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-02-26 06:07 EST — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-02-26 07:07 EST — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-02-26 08:07 EST — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-02-26 09:07 EST — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-02-26 10:07 EST — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-02-26 11:07 EST — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-02-26 12:07 EST — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-02-26 13:07 EST — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-02-26 14:07 EST — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-02-26 15:07 EST — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-02-26 16:07 EST — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-02-26 17:07 EST — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-02-26 18:07 EST — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-02-26 19:07 EST — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-02-26 20:07 EST — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-02-27 00:07 EST — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-02-27 01:07 EST — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-02-27 02:07 EST — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-02-27 03:07 EST — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-02-27 04:07 EST — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-02-27 05:07 EST — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-02-27 06:07 EST — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-02-27 07:07 EST — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-02-27 08:07 EST — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-02-27 09:07 EST — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-02-27 10:07 EST — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-02-27 11:07 EST — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-02-27 12:07 EST — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-02-27 14:07 EST — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-02-27 15:07 EST — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-02-27 16:07 EST — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-02-27 17:07 EST — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-02-27 18:07 EST — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-02-27 19:07 EST — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-02-27 20:07 EST — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-02-27 21:07 EST — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-02-27 22:07 EST — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-02-27 23:07 EST — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-02-28 00:07 EST — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-02-28 01:07 EST — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-02-28 02:07 EST — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-02-28 03:07 EST — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-02-28 04:07 EST — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-02-28 05:07 EST — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-02-28 06:07 EST — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-02-28 07:07 EST — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-02-28 08:07 EST — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-02-28 09:07 EST — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-02-28 10:07 EST — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-02-28 11:07 EST — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-02-28 12:07 EST — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-02-28 13:07 EST — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-02-28 14:07 EST — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-02-28 15:07 EST — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-02-28 16:07 EST — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-02-28 17:07 EST — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-02-28 18:07 EST — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-02-28 19:07 EST — docs sync
- Updated: docs/meta/source-to-export-map.json
- Updated: docs/optional/context-engineering.md
- Updated: docs/optional/jsonl-memory.md
- Updated: starter-kit/README.md
- Updated: starter-kit/workflows/spawn-code-subagent.lobster
- Updated: starter-kit/workflows/write-prose.lobster
- Updated: templates/AGENTS-template.md
- Updated: templates/HEARTBEAT-template.md
- Updated: templates/identity-template.md
- Updated: templates/ontology-template.md
- Updated: templates/soul-template.md
- Updated: templates/tools-template.md

## 2026-02-28 20:07 EST — docs sync
- Updated: docs/meta/source-to-export-map.json
- Updated: docs/optional/context-engineering.md
- Updated: docs/optional/jsonl-memory.md
- Updated: starter-kit/workflows/spawn-code-subagent.lobster
- Updated: starter-kit/workflows/write-prose.lobster
- Updated: templates/AGENTS-template.md
- Updated: templates/identity-template.md
- Updated: templates/ontology-template.md
- Updated: templates/soul-template.md
- Updated: templates/tools-template.md

## 2026-03-10 16:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json
- Updated: templates/AGENTS-template.md

## 2026-03-10 17:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-10 18:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-10 19:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-10 20:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-10 21:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-10 22:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-10 23:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-11 00:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-11 01:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-11 02:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-11 03:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-11 04:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-11 05:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-11 06:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-11 07:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-11 08:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-11 09:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-11 10:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-13 10:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json
- Updated: templates/AGENTS-template.md

## 2026-03-14 13:43 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json
- Updated: templates/HEARTBEAT-template.md

## 2026-03-14 14:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-14 15:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-14 16:11 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-14 17:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-14 18:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-14 19:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-14 20:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-14 21:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-14 22:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-14 23:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-15 00:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-15 01:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-15 02:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-15 03:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-15 04:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-15 05:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-15 06:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-15 07:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-15 08:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-15 09:15 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-15 10:16 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-15 11:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-15 12:13 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-15 13:12 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-15 14:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-15 16:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-15 17:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-15 18:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-15 19:10 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-15 20:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-15 21:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-15 22:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-15 23:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-16 00:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-16 01:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-16 02:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-16 03:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-16 04:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-16 05:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-16 06:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-16 07:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-16 08:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-16 09:11 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-16 10:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-16 11:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-16 12:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-16 14:38 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-16 15:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-16 16:16 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-16 17:15 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-16 18:16 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-16 19:16 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-16 20:10 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-16 21:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-16 22:11 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-16 23:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-17 00:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-17 01:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-17 02:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-17 03:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-17 04:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-17 05:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-17 06:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-17 07:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-17 08:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-17 09:16 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-17 10:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-17 11:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-17 12:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-17 13:18 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-17 14:12 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-17 15:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-17 16:17 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-17 17:12 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-17 18:13 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-17 19:14 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-17 20:16 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-17 21:11 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-17 22:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-17 23:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-18 00:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-18 01:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-18 02:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-18 03:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-18 04:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-18 05:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-18 06:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-18 07:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-18 08:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-18 09:18 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-18 10:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-18 11:15 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-18 12:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-18 13:12 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-18 14:21 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-18 15:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-18 16:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-18 17:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-18 21:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-18 22:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-18 23:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-19 00:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-19 01:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-19 02:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-19 03:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-19 04:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-19 05:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-19 06:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-19 07:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-19 08:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-19 08:11 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-19 09:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-19 10:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-19 11:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-19 12:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-19 13:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-19 14:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-19 15:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-19 16:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-19 17:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-19 18:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-19 19:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-19 20:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-19 21:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-19 22:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-19 23:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-20 00:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-20 01:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-20 02:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-20 03:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-20 04:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-20 05:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-20 06:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-20 07:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-20 08:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-20 09:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-20 10:16 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-20 11:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-20 12:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-20 13:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-20 14:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-20 15:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-20 16:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-20 17:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-20 18:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-20 19:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-20 20:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-20 21:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-20 22:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-20 23:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-21 00:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-21 01:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-21 02:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-21 03:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-21 04:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-21 05:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-21 06:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-21 07:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-21 08:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-21 09:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-21 10:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-21 11:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-21 12:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-21 13:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-21 14:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-21 15:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-21 16:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-21 17:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-21 18:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-21 19:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-21 20:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-21 21:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-21 22:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-21 23:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-22 00:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-22 01:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-22 02:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-22 03:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-22 04:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-22 05:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-22 06:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-22 07:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-22 08:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-22 09:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-22 10:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-22 11:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-22 12:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-22 13:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-22 14:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-22 15:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-22 16:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-22 17:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-22 18:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-22 19:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-22 20:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-22 21:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-22 22:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-22 23:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-23 00:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-23 01:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-23 02:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-23 03:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-23 04:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-23 05:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-23 06:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-23 07:13 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-23 08:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-23 09:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-23 10:12 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-23 11:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-23 13:29 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-23 13:56 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-23 14:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-23 15:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-23 16:11 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-23 17:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-23 18:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-23 19:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-23 20:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-23 21:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-23 22:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-23 23:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-24 00:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-24 01:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-24 02:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-24 03:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-24 04:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-24 05:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-24 06:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-24 07:16 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-24 08:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-24 09:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-24 10:17 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-24 11:14 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-24 12:20 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-24 13:13 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-24 14:15 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-24 15:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-24 16:26 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-24 20:11 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-24 21:14 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-24 22:23 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-24 23:10 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-25 00:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-25 01:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-25 02:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-25 03:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-25 04:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-25 05:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-25 06:12 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-25 07:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-25 08:14 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-25 10:39 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-25 11:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-25 12:17 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-25 13:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-25 14:14 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-25 16:39 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-25 17:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-25 18:13 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-25 19:10 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-25 20:15 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-25 22:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-25 23:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-26 00:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-26 01:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-26 02:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-26 03:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-26 04:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-26 05:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-26 06:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-26 07:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-26 08:22 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-26 09:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-26 11:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-26 12:10 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-26 14:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-26 15:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-26 16:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-26 17:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-26 18:11 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-26 20:25 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-26 21:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-26 22:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-26 23:25 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-27 00:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-27 01:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-27 02:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-27 03:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-27 04:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-27 05:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-27 06:12 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-27 07:16 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-27 08:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-27 09:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-27 10:06 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-27 10:24 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-27 11:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json
- Updated: starter-kit/README.md
- Updated: templates/MEMORY.template.md
- Updated: templates/ONTOLOGY.template.md
- Updated: templates/TOOLS.template.md
- Updated: templates/USER.template.md

## 2026-03-27 12:09 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-27 13:15 EDT — docs sync
- Updated: docs/meta/source-to-export-map.json
- Updated: starter-kit/README.md
- Updated: starter-kit/templates/OKR-TASK-BOARD.template.md
- Updated: starter-kit/templates/PROJECT-KICKOFF-PACK.template.md
- Updated: starter-kit/templates/okr-task-board-template.md
- Updated: starter-kit/templates/project-kickoff-pack-template.md

## 2026-03-27 16:35 EDT — docs sync
- Updated: starter-kit/README.md
