# jarvOS Starter Kit

## Mandatory Flow: Kickoff Before Build

Before writing implementation code, complete project planning artifacts:

1. Fill `templates/PROJECT-KICKOFF-PACK.template.md`
2. Define OKRs (objective + measurable KRs)
3. Initialize `templates/OKR-TASK-BOARD.template.md`
4. Ensure each task maps to a KR and passes quality gates
5. Begin build only after kickoff gate is fully checked

This keeps execution outcome-driven, auditable, and portable.

## Runtime Onboarding Defaults (Core)

Runtime onboarding behavior is inherited from jarvOS core templates (`jarvos/templates/AGENTS-template.md` + `jarvos/templates/BOOTSTRAP-template.md`):
- activation-first onboarding finish (1-3 concrete activation tasks)
- brief-first setup (daily + weekly brief/review early)
- proactive next-work closeouts (1-3 concrete options, unless user explicitly ends)
- "search the last X days" interpreted as web-first lastXdays research, with local recall as support

## Project Governance Policy v1 (Default)

All project work should follow this baseline:
- link projects to Portfolio + Program by default
- if no fit exists, set `Program: Incubator` with reason + review date
- keep `Project Board.md` + `Project Brief.md` as a required pair
- maintain 3-6 milestones/decision gates per project
- hotfixes can start fast, but governance backfill is required in the same session

## Included Reusable Templates

- `templates/PROJECT-KICKOFF-PACK.template.md`
- `templates/OKR-TASK-BOARD.template.md`

---

## Runtime Modules (`modules/`)

The `modules/` directory at the repo root contains the three core jarvOS runtime modules. These give your agent executable code — not just markdown templates.

### What's included

| Module | What it provides |
|--------|-----------------|
| [`modules/jarvos-memory`](../modules/jarvos-memory/) | Memory schema, audit helpers, promotion rules — your agent's durable state contract |
| [`modules/jarvos-ontology`](../modules/jarvos-ontology/) | Ontology tooling — read, write, validate, and render your belief/goal graph |
| [`modules/jarvos-secondbrain`](../modules/jarvos-secondbrain/) | Vault bridges, journal/notes packages, capture routing — the content layer |

### Wiring modules into your starter-kit workflow

1. **Memory audits** — Point `jarvos-memory`'s audit script at your MEMORY.md:
   ```bash
   cd modules/jarvos-memory && npm install
   node scripts/audit-memory.js --file /path/to/your/MEMORY.md
   ```

2. **Ontology templates** — Copy `modules/jarvos-ontology/schema/templates/` to your local `ontology/` directory and fill them in. These are the blank forms for your beliefs, goals, predictions, etc.

3. **Path configuration** — Copy `modules/jarvos-secondbrain/jarvos.config.example.json` to `~/clawd/jarvos.config.json` (or set `JARVOS_*` env vars) so the secondbrain module knows where your vault lives.

4. **Validate your ontology** — Once filled in:
   ```bash
   cd modules/jarvos-ontology && npm install
   node scripts/validate.js --ontology /path/to/your/ontology/
   ```

See [`modules/README.md`](../modules/README.md) for full module documentation.
