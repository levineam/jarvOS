# @jarvos/gbrain

Structured knowledge bridge for jarvOS. This module imports a curated slice of an
Obsidian-compatible vault into a GBrain repo, then provides sync, doctor, and
retrieval-eval helpers.

## What this module owns

| Surface | Description |
|---|---|
| **Curated import manifest** | Explicit list of notes worth turning into GBrain pages |
| **GBrain page generation** | Deterministic pages for people, companies, projects, concepts, meetings, and sources |
| **Provenance** | Original vault path, source type, imported timestamp, and generator metadata |
| **Sync wrapper** | Safe wrapper around `gbrain sync --repo <brainDir>` and `gbrain embed --stale` |
| **Retrieval eval** | Small fixture-driven checks for whether GBrain can answer expected questions |
| **Graph recall** | Compact wrapper around `gbrain graph-query` for sidecar recall from known seed pages |
| **Runtime recall bundle** | One callable bundle for GBrain search, optional QMD lookup, and graph sidecar context |

## What this module is NOT for

| Use this instead | For |
|---|---|
| `@jarvos/secondbrain` | Writing and maintaining the human-facing vault |
| `@jarvos/memory` | Compact operational recall, preferences, decisions, lessons |
| `@jarvos/ontology` | Values, goals, beliefs, predictions, and worldview structure |
| QMD | Fast keyword search and exact lookup across the full vault |
| OpenClaw `memory-wiki` | Runtime-native wiki status, lint, dashboards, and diagnostics |

## Quick Start

```bash
npm install ./modules/jarvos-gbrain
```

```bash
cd modules/jarvos-gbrain
npm install
node scripts/jarvos-gbrain.js doctor
node scripts/jarvos-gbrain.js plan --manifest /path/to/curated-import.json
node scripts/jarvos-gbrain.js import --dry-run --manifest /path/to/curated-import.json
node scripts/jarvos-gbrain.js sync --dry-run
node scripts/jarvos-gbrain.js graph --seed projects/jarvos-context-engineering-upgrade --depth 2
node scripts/jarvos-gbrain.js recall --query "What connects Paperclip and OpenClaw?" --format markdown
```

## Configuration

Path resolution uses explicit overrides first, then the shared jarvOS path
resolver from `@jarvos/secondbrain`, then portable defaults:

| Env var | Default | Purpose |
|---|---|---|
| `JARVOS_VAULT_DIR` | shared jarvOS resolver, then `~/Documents/Vault v3` | Obsidian-compatible vault root |
| `JARVOS_NOTES_DIR` | shared jarvOS resolver, then `$JARVOS_VAULT_DIR/Notes` | Notes directory for local callers |
| `JARVOS_BRAIN_DIR` | `~/brain` | GBrain content repo |
| `JARVOS_GBRAIN_DIR` | `~/gbrain` | GBrain source/CLI repo |
| `JARVOS_GBRAIN_BIN` | `gbrain` | GBrain CLI command |
| `JARVOS_QMD_BIN` | `qmd` | QMD CLI command for optional comparison evals |
| `JARVOS_QMD_MODE` | `search` | QMD command for comparison evals: `search`, `query`, or `vsearch` |
| `JARVOS_QMD_COLLECTION` | unset | Optional QMD collection filter |
| `JARVOS_QMD_INDEX` | unset | Optional QMD index name |
| `JARVOS_RETRIEVAL_TIMEOUT_MS` | `15000` | Per-query timeout for retrieval eval commands |
| `JARVOS_GBRAIN_IMPORT_MANIFEST` | `<package-root>/config/curated-import.json` | Import manifest |
| `JARVOS_GBRAIN_EVAL_QUESTIONS` | `<package-root>/config/eval-questions.json` | Retrieval eval fixture |

The public repo ships template manifest/eval files only. Put private note lists
and private eval questions in your local workspace and point env vars or CLI flags
at those files.

## Curated Import Manifest

```json
{
  "version": 1,
  "items": [
    {
      "type": "project",
      "title": "JarVOS Brain Integration",
      "sourcePath": "Notes/JarVOS Brain Integration.md",
      "slug": "jarvos-brain-integration",
      "tags": ["jarvos", "gbrain"],
      "summary": "Why this note belongs in structured GBrain knowledge.",
      "related": ["concepts/personal-ai-os"],
      "sources": ["sources/jarvos-architecture"]
    }
  ]
}
```

Supported types: `person`, `company`, `project`, `concept`, `meeting`, and
`source`. Relative `sourcePath` values are resolved from `JARVOS_VAULT_DIR`.
Original vault notes are never mutated by this module.

Optional graph-friendly fields can be placed directly on each item or under
`graph` / `relationships`: `aliases`, `company`, `companies`, `founded`,
`key_people`, `partner`, `investors`, `lead`, `attendees`, `related`,
`see_also`, and `sources`. These render into YAML frontmatter and a `Graph Links`
section with wikilinks so GBrain can extract typed relationships.

## Public API

```js
const {
  createImportPlan,
  importToBrain,
  syncBrain,
  runRetrievalEval,
  graphRecall,
  recallBundle,
  renderRecallMarkdown,
  doctor,
} = require('@jarvos/gbrain');
```

- `createImportPlan(config)` reads the manifest and returns planned source/target pairs.
- `importToBrain(plan, { dryRun })` generates GBrain pages; dry-run reports writes without writing.
- `syncBrain(config, { dryRun })` wraps `gbrain sync --repo <brainDir>` and `gbrain embed --stale`.
- `runRetrievalEval(config, { dryRun, compareQmd })` runs fixture queries through GBrain search and optionally QMD, then fails questions whose expected evidence is missing.
- `graphRecall(config, { seeds, depth, dryRun })` runs `gbrain graph-query <seed> --depth <n>` and returns parsed graph nodes for sidecar recall.
- `recallBundle(config, { query, includeQmd, autoGraph, seeds })` returns a compact runtime bundle with direct GBrain search, optional QMD broad lookup, and graph sidecar expansion.
- `renderRecallMarkdown(bundle)` renders a bundle into context-ready Markdown.
- `doctor(config)` checks manifest, eval file, brain directory, GBrain directory, and CLI availability.

## Retrieval Eval Fixture

```json
{
  "version": 1,
  "questions": [
    {
      "query": "Where is the JarVOS brain integration context?",
      "expected": {
        "slug": "projects/jarvos-brain",
        "any": ["Important context", "fallback context"]
      }
    }
  ]
}
```

`expected` may be a string, an array of required strings, or an object with
`slug`, `slugs`, `title`, `text`, `contains`, `all`, and `any` checks. String
matching is case-insensitive against `gbrain search` output.

Run comparison evals with:

```bash
node scripts/jarvos-gbrain.js eval --eval-file /path/to/eval-questions.json --compare-qmd
```

When using `--compare-qmd`, each question runs against GBrain and QMD. Use
engine-specific expected evidence when the same answer has different identifiers
in each engine. You may also provide `gbrainQuery` or `qmdQuery` when a runtime
planner should send a keywordized tool query while preserving the human-facing
question:

```json
{
  "query": "Where is the OpenClaw gateway recovery runbook?",
  "qmdQuery": "OpenClaw gateway auth recovery",
  "expected": {
    "gbrain": {
      "slug": "sources/openclaw-gateway-auth-recovery-playbook",
      "any": ["gateway", "auth"]
    },
    "qmd": {
      "all": ["qmd://notes/openclaw-gateway-auth-recovery-playbook.md"],
      "any": ["OpenClaw Gateway", "auth"]
    }
  }
}
```

This comparison does not decide that one engine should replace the other. It
shows where GBrain is strong enough for structured recall and where QMD still
wins for broad vault lookup.

For cross-source questions, add graph seeds and run the graph sidecar comparison:

```bash
node scripts/jarvos-gbrain.js eval \
  --eval-file /path/to/eval-questions.json \
  --compare-qmd \
  --compare-graph
```

```json
{
  "query": "What connects memory behavior and agent continuity?",
  "graphSeeds": ["projects/jarvos-context-engineering-upgrade"],
  "expected": {
    "gbrain": "projects/jarvos-context-engineering-upgrade",
    "graph": {
      "all": ["concepts/openclaw-context-management-lessons"],
      "any": ["memory", "continuity"]
    }
  }
}
```

The `gbrain_graph` engine is reported separately from direct GBrain search. Use
it to prove sidecar graph traversal covers multi-hop questions without masking
direct-search misses.

## Graph Recall

Use graph recall when a planner or runtime already has a likely GBrain seed page
and needs nearby structured context for a cross-source question:

```bash
node scripts/jarvos-gbrain.js graph \
  --seed projects/jarvos-context-engineering-upgrade \
  --seed sources/paperclip-openclaw-setup-guide-draft \
  --depth 2
```

The command returns one result per seed with parsed GBrain graph nodes. This is
intended as the sidecar path after direct search has found an anchor page; broad
vault lookup still belongs to QMD.

## Runtime Recall Bundle

Use the recall bundle as the stable OpenClaw/jarVOS call surface for a user
question. It keeps the retrieval layers distinct while returning one compact
payload that can be injected into context:

```bash
node scripts/jarvos-gbrain.js recall \
  --query "What connects Paperclip setup, jarvOS task management, and OpenClaw operation?" \
  --format markdown
```

By default, the bundle runs direct GBrain search, QMD broad lookup, and graph
expansion from the first GBrain search slugs. Use `--graph-seed` to force known
anchors, `--no-qmd` when QMD is unavailable, or `--no-graph` when only direct
search is needed.

This command is a retrieval adapter, not automatic prompt injection. Runtime
wiring should decide when to call it and how much of its Markdown to include.

## Role in the jarvOS Architecture

`@jarvos/gbrain` is the structured knowledge layer. It does not replace QMD or
OpenClaw memory-wiki:

- QMD remains the broad, fast vault lookup path.
- memory-wiki remains a native OpenClaw compiled wiki and diagnostic dashboard.
- GBrain becomes the graph-like source for people, companies, projects, concepts,
  meetings, source pages, and other structured knowledge that should survive
  across runtimes.
