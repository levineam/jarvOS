# jarvOS Modules

The core modules that make jarvOS work. Each module is a standalone npm package
with a clear boundary and a dedicated README.

| Module | Purpose | Key entry point |
|---|---|---|
| [`@jarvos/memory`](./jarvos-memory/) | Agent-state memory — compact recall across sessions | `src/index.js` |
| [`@jarvos/ontology`](./jarvos-ontology/) | Worldview layer — beliefs, goals, values, predictions | `src/index.js` |
| [`@jarvos/secondbrain`](./jarvos-secondbrain/) | Content layer — journal and notes | `bridge/config/jarvos-paths.js` |
| [`@jarvos/gbrain`](./jarvos-gbrain/) | GBrain-first structured resolver — curated vault import, graph recall, and runtime recall bundles | `src/index.js` |
| [`@jarvos/agent-context`](./jarvos-agent-context/) | Runtime-facing adapter — recall, current work, note actions, MCP | `src/index.js` |

## Architecture

```
Raw capture (journal/notes)
  → @jarvos/secondbrain (content layer)
    → @jarvos/memory (compact retained state)
      → @jarvos/ontology (worldview / belief graph)
        → @jarvos/gbrain (structured people/projects/concepts/sources)
        → Paperclip (live execution tracking)
```

## Quick Install

```bash
# From the root of this repo
npm install ./modules/jarvos-memory ./modules/jarvos-ontology ./modules/jarvos-secondbrain ./modules/jarvos-gbrain ./modules/jarvos-agent-context
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
| Structured knowledge + resolver | `@jarvos/gbrain` | First-pass structured recall for people, companies, projects, concepts, meetings, source pages |
| Execution | Paperclip | Tasks, issues, assignments, done/not-done |

## Smoke Test

Run `npm test` from the repo root, or:

```bash
node tests/modules-smoke-test.js
```

---

## @jarvos/memory

**What it does:** Defines the agent-state memory contract. This is where durable facts live — preferences, decisions-with-rationale, lessons learned, and project-state snapshots that agents carry across sessions.

**What it is NOT:** A journal or content store. Day-to-day notes belong in `@jarvos/secondbrain`.

**Quick start:**

```bash
cd modules/jarvos-memory
npm install
node scripts/audit-memory.js --help
```

**Key files:**

- `src/` — core library (schema, records, config, audit helpers)
- `scripts/audit-memory.js` — CLI to audit your MEMORY.md against the schema
- `docs/` — promotion rules, flush timing, compaction survival guides

---

## @jarvos/ontology

**What it does:** Structured belief graph — who you are, what you believe, what you predict, and where you're headed. Six ontology layers: higher-order principles, beliefs, predictions, core self, goals, projects.

**What it is NOT:** Your actual ontology data. The templates live in `schema/templates/`. Your filled-in data stays private in your local workspace.

**Quick start:**

```bash
cd modules/jarvos-ontology
npm install
# Copy schema/templates/ to your ontology/ directory and fill them in
node scripts/validate.js --help
node scripts/render.js --help
```

**Key files:**

- `src/` — reader, writer, validator, renderer, extractor, bridge
- `schema/templates/` — blank templates for all six ontology layers
- `schema/heuristics.md` — rules for what belongs in each layer
- `scripts/` — validate, render, extract, sync-to-paperclip
- `test/` — unit tests for all src modules

---

## @jarvos/secondbrain

**What it does:** Content-facing monorepo skeleton — journal maintenance, notes management, vault bridges (Obsidian, OpenClaw), and capture routing. Configurable via env vars or `jarvos.config.json`.

**What it is NOT:** Your actual notes/journal. Those live in your vault (default: `~/Documents/Vault v3`, override via `JARVOS_VAULT_DIR`).

**Quick start:**

```bash
cd modules/jarvos-secondbrain
npm install
# Copy jarvos.config.example.json → ~/clawd/jarvos.config.json and fill in your paths
JARVOS_VAULT_DIR=/path/to/your/vault node bridge/config/jarvos-paths.js
```

**Key files:**

- `bridge/config/jarvos-paths.js` — shared path resolution (all env-var driven, no hardcoded paths)
- `bridge/routing/` — keyword capture router, salience detector
- `bridge/provenance/` — journal-note audit and provenance tracking
- `adapters/obsidian/` — Obsidian vault storage adapter
- `adapters/openclaw/` — OpenClaw adapter notes
- `packages/jarvos-secondbrain-journal/` — journal maintenance package
- `packages/jarvos-secondbrain-notes/` — notes management package
- `jarvos.config.example.json` — example config with all configurable paths

**Configuration:**

All paths are resolved via environment variables or `jarvos.config.json`. See `bridge/config/jarvos-paths.js` for the full resolution order.

| Env var | Default | Purpose |
|---------|---------|---------|
| `JARVOS_CLAWD_DIR` | `~/clawd` | Workspace root |
| `JARVOS_VAULT_DIR` | `~/Documents/Vault v3` | Obsidian vault root |
| `JARVOS_JOURNAL_DIR` | `$JARVOS_VAULT_DIR/Journal` | Daily journal directory |
| `JARVOS_NOTES_DIR` | `$JARVOS_VAULT_DIR/Notes` | Notes directory |

---

## @jarvos/gbrain

**What it does:** Provides the GBrain-first structured resolver for jarvOS. It
imports a curated slice of your Obsidian-compatible vault into GBrain and
generates deterministic GBrain pages for people, companies, projects, concepts,
meetings, and sources while preserving source provenance.
Curated manifest items may also include graph-friendly relationship fields such
as `company`, `key_people`, `attendees`, `related`, `see_also`, and `sources`.
It also provides retrieval evals, graph sidecar recall, and a runtime recall
bundle that resolves through GBrain first, uses graph expansion for adjacent
context, and calls QMD, when enabled, as broad vault lookup or exact source-note
support.

**What it is NOT:** A full-vault search engine or a replacement for QMD. QMD
remains the broad, fast vault lookup path. OpenClaw `memory-wiki` remains a
runtime-native diagnostic/compiled-wiki layer.

**Quick start:**

```bash
cd modules/jarvos-gbrain
npm install
node scripts/jarvos-gbrain.js doctor
node scripts/jarvos-gbrain.js import --dry-run --manifest /path/to/curated-import.json
node scripts/jarvos-gbrain.js sync --dry-run
node scripts/jarvos-gbrain.js eval --eval-file /path/to/eval-questions.json --compare-qmd --compare-graph --compare-recall
node scripts/jarvos-gbrain.js recall --query "What should my assistant know about this project?" --format markdown
```

**Key files:**

- `src/index.js` — import planning, page generation, sync wrapper, eval, graph recall, runtime recall, doctor
- `scripts/jarvos-gbrain.js` — CLI entry point
- `config/curated-import.json` — public template manifest
- `config/eval-questions.json` — public template retrieval-eval fixture
- `test/` — unit tests for mapping, provenance, dry-run behavior, and sync planning

**Operating loop:**

1. Keep private notes in the vault.
2. Maintain a private curated GBrain import manifest outside this repo.
3. Run import/sync/embed against that manifest.
4. Prove recall quality with private eval questions.
5. Use GBrain search/graph/recall as the structured runtime context resolver,
   with QMD as broad lookup and exact source-note support. QMD is enabled by
   default in the recall bundle; pass `--no-qmd` for GBrain-only runtime calls.
6. In OpenClaw or another runtime, automate a report-only maintenance loop that
   refreshes indexes, checks GBrain and memory-wiki health, runs combined evals,
   and proposes manifest additions without auto-promoting notes.
7. Add a daily readable audit on top of the quiet maintenance loop so the user
   can see, without remembering the system design, what was checked, why it
   matters, what changed, and what needs attention.

**Embedding provider rule:** do not switch a live GBrain store from one embedding
model family to another without treating it as a migration. Record current
`gbrain stats`, `gbrain doctor --json`, and retrieval eval results; back up the
database; verify the new model's vector dimensions; then reinitialize or migrate
and re-embed with rollback proof. Local Ollama models such as
`mxbai-embed-large` are suitable for private deployments when their dimensions
match the store or the migration plan explicitly changes the store.

**Configuration:**

| Env var | Default | Purpose |
|---------|---------|---------|
| `JARVOS_VAULT_DIR` | shared jarvOS resolver, then `~/Documents/Vault v3` | Obsidian-compatible vault root |
| `JARVOS_NOTES_DIR` | shared jarvOS resolver, then `$JARVOS_VAULT_DIR/Notes` | Notes directory for local callers |
| `JARVOS_BRAIN_DIR` | `~/brain` | GBrain content repo |
| `JARVOS_GBRAIN_DIR` | `~/gbrain` | GBrain source/CLI repo |
| `JARVOS_GBRAIN_BIN` | `gbrain` | GBrain CLI command |
| `JARVOS_GBRAIN_IMPORT_MANIFEST` | `<package-root>/config/curated-import.json` | Curated import manifest |
| `JARVOS_GBRAIN_EVAL_QUESTIONS` | `<package-root>/config/eval-questions.json` | Retrieval eval fixture |

---

## @jarvos/agent-context

**What it does:** Provides the runtime-facing jarvOS adapter for agent clients
such as Codex CLI and Claude Code. It exposes one shared library and stdio MCP
server for current work, GBrain/QMD/graph recall, startup briefs, and verified
Obsidian note creation.

**What it is NOT:** A new memory backend. It calls the existing jarvOS modules
and Paperclip instead of storing private knowledge itself.

**Quick start:**

```bash
cd modules/jarvos-agent-context
npm test
node scripts/jarvos-mcp.js startup-brief
```

**Codex setup:**

```bash
codex mcp add jarvos -- node /path/to/jarvOS/modules/jarvos-agent-context/scripts/jarvos-mcp.js
```

---

## Architecture Decision: Monorepo

These modules are included directly in this repo (not as git submodules, not as npm packages) because:

1. **Clone-to-use** — one `git clone` gets you everything that runs
2. **No registry friction** — no npm publish, no version pinning headaches
3. **Portable** — the core behavioral layer and the runtime modules travel together
4. **Transparent** — users can read and modify the source without going somewhere else

For the full decision record, see [SUP-457 / SUP-487 in the project tracker](https://github.com/levineam/jarvOS).

---

## Privacy Boundary

The modules here contain **generic code and schema templates only**. Your personal data (actual ontology content, memories, journal entries) lives in your local workspace and is never part of this repo.

See [`PUBLIC_BASELINE.md`](../PUBLIC_BASELINE.md) at the repo root for the full public/private boundary documentation.
