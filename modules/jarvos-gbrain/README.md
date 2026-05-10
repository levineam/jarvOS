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
  doctor,
} = require('@jarvos/gbrain');
```

- `createImportPlan(config)` reads the manifest and returns planned source/target pairs.
- `importToBrain(plan, { dryRun })` generates GBrain pages; dry-run reports writes without writing.
- `syncBrain(config, { dryRun })` wraps `gbrain sync --repo <brainDir>` and `gbrain embed --stale`.
- `runRetrievalEval(config, { dryRun })` runs fixture queries through GBrain search and fails questions whose `expected` evidence is missing from search output.
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

## Role in the jarvOS Architecture

`@jarvos/gbrain` is the structured knowledge layer. It does not replace QMD or
OpenClaw memory-wiki:

- QMD remains the broad, fast vault lookup path.
- memory-wiki remains a native OpenClaw compiled wiki and diagnostic dashboard.
- GBrain becomes the graph-like source for people, companies, projects, concepts,
  meetings, source pages, and other structured knowledge that should survive
  across runtimes.
