# Changelog

All notable public-doc sync changes are appended by `jarvos-public-docs-sync.sh`.

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

## 2026-02-28 21:07 EST — docs sync
- Updated: docs/meta/source-to-export-map.json
- Updated: templates/AGENTS-template.md

## 2026-02-28 22:07 EST — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-02-28 23:07 EST — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-01 00:07 EST — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-01 01:07 EST — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-01 02:07 EST — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-01 03:07 EST — docs sync
- Updated: docs/meta/source-to-export-map.json

## 2026-03-01 04:07 EST — docs sync
- Updated: docs/meta/source-to-export-map.json
