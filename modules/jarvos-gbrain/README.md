# @jarvos/gbrain

GBrain-first resolver/brain integration for jarvOS. This module imports a
curated slice of an Obsidian-compatible vault into a local GBrain repo, then
provides sync, doctor, graph recall, runtime recall-bundle, and retrieval-eval
helpers.

It does not implement GBrain or ship a private graph. It is the jarvOS adapter
that makes an installed GBrain usable as the first structured recall layer for
people, projects, concepts, meetings, and source pages.

## What this module owns

| Surface | Description |
|---|---|
| **Curated import manifest** | Explicit list of notes worth turning into GBrain pages |
| **GBrain page generation** | Deterministic pages for people, companies, projects, concepts, meetings, and sources |
| **Provenance** | Original vault path, source type, imported timestamp, and generator metadata |
| **Sync wrapper** | Safe wrapper around `gbrain sync --repo <brainDir>` and `gbrain embed --stale` |
| **Retrieval eval** | Small fixture-driven checks for whether GBrain can answer expected questions |
| **Graph recall** | Compact wrapper around `gbrain graph-query` for sidecar recall from known seed pages |
| **Runtime resolver bundle** | One callable bundle for GBrain search, optional QMD lookup, and graph sidecar context |
| **Managed provider launcher** | Revalidates an owner-controlled GBrain source and interpreter before each provider-native stdio launch |

## What this module is NOT for

| Use this instead | For |
|---|---|
| `@jarvos/secondbrain` | Writing and maintaining the human-facing vault |
| `@jarvos/memory` | Compact operational recall, preferences, decisions, lessons |
| `@jarvos/ontology` | Values, goals, beliefs, predictions, and worldview structure |
| QMD | Fast keyword search and exact lookup across the full vault |
| OpenClaw `memory-wiki` | Runtime-native wiki status, lint, dashboards, and diagnostics |

For the broader external secondbrain integration inventory, including QMD,
GBrain, memory-wiki, generated LLM-wiki, agentmemory, and Engraph status, see
the public
[secondbrain external integration inventory](https://github.com/levineam/jarvOS/blob/main/docs/architecture/secondbrain-external-integrations.md).

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

## Shared-brain continuity

GBrain remains an optional external provider in portable jarvOS. A private
profile may require it for continuity across Codex, Hermes, and OpenClaw. The
three harnesses register the same provider-native stdio server through
`scripts/jarvos-gbrain-provider.js`; jarvOS does not proxy GBrain tools or copy
provider skills into its shared-skill bundle.

The launcher reads the absolute path in
`JARVOS_GBRAIN_RUNTIME_DESCRIPTOR`. The descriptor must be a regular,
owner-controlled `0600` JSON file. It pins the GBrain source entry, its
interpreter, the provider-owned skill manifest, and Skillify by realpath,
owner, mode, and SHA-256; names the stable logical store tuple; and supplies
absolute GBrain home/store roots. The launcher sets `GBRAIN_SKILLS_DIR` from
that pin, so neutral-cwd launches cannot silently resolve some other skill
tree. Database URLs and provider credentials do not belong in harness
configuration or descriptor environment fields; keep them in GBrain's
owner-only configuration.

```json
{
  "schemaVersion": "jarvos-gbrain-runtime-descriptor/v1",
  "executablePath": "/absolute/release/src/cli.ts",
  "sha256": "<sha256>",
  "expectedOwnerUid": 501,
  "version": "0.46.32.0",
  "commit": "<40-character-commit>",
  "engineKind": "postgres",
  "storeIdentity": { "host": "127.0.0.1", "port": 5432, "database": "gbrain" },
  "gbrainHome": "/absolute/owner-home",
  "gbrainStore": "/absolute/owner-store",
  "providerEnv": { "GBRAIN_BRAIN_ID": "host" },
  "interpreter": {
    "executablePath": "/absolute/bin/bun",
    "sha256": "<sha256>",
    "expectedOwnerUid": 501
  },
  "skills": {
    "directoryPath": "/absolute/release/skills",
    "manifestSha256": "<sha256>",
    "skillifySha256": "<sha256>"
  }
}
```

Every launch uses a neutral working directory, a fixed minimal `PATH`, and
`GBRAIN_SWEEP=0`. The scheduler-owned delta-maintenance path remains the sole
maintenance owner. Skillify stays in GBrain's skill tree and is discovered
through GBrain's `list_skills` / `get_skill` resolver tools; copying its
`SKILL.md` into a jarvOS or harness skill directory would break provenance.

The continuity producer accepts an owner-only
`jarvos-gbrain-continuity-producer-input/v1` declaration, not a completed
health snapshot. It revalidates this same runtime descriptor, issues a fresh
challenge, and runs the ordered Codex, Hermes, and OpenClaw native probe
commands directly. Each probe must return the exact
`jarvos-gbrain-native-probe/v1` result bound to the supplied challenge,
generation, jarvOS runtime, and GBrain runtime. The producer computes
cross-harness brain equality and constructs the trusted snapshot; failed,
replayed, mismatched, or malformed probe output remains below live proof.

The producer input contains only orchestration declarations and boolean safety
gates; it cannot supply the resulting brain, store, fixture, or trust facts:

```json
{
  "schema": "jarvos-gbrain-continuity-producer-input/v1",
  "generation": 1,
  "validForSeconds": 1800,
  "jarvosRuntimeDigest": "sha256:<sha256>",
  "targets": [
    {
      "target": "codex",
      "command": "/absolute/owner-controlled/codex-probe",
      "args": [],
      "timeoutMs": 120000,
      "maintenanceBlocked": false,
      "backupFresh": true
    },
    { "target": "hermes", "command": "/absolute/owner-controlled/hermes-probe", "args": [], "timeoutMs": 120000, "maintenanceBlocked": false, "backupFresh": true },
    { "target": "openclaw", "command": "/absolute/owner-controlled/openclaw-probe", "args": [], "timeoutMs": 120000, "maintenanceBlocked": false, "backupFresh": true }
  ]
}
```

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
  loadManagedRuntimeDescriptor,
  prepareManagedGbrainProvider,
  doctor,
} = require('@jarvos/gbrain');
```

- `createImportPlan(config)` reads the manifest and returns planned source/target pairs.
- `importToBrain(plan, { dryRun })` generates GBrain pages; dry-run reports writes without writing.
- `syncBrain(config, { dryRun })` wraps `gbrain sync --repo <brainDir>` and `gbrain embed --stale`.
- `runRetrievalEval(config, { dryRun, compareQmd })` runs fixture queries through GBrain search and optionally QMD, then fails questions whose expected evidence is missing.
- `graphRecall(config, { seeds, depth, dryRun })` runs `gbrain graph-query <seed> --depth <n>` and returns parsed graph nodes for sidecar recall.
- `recallBundle(config, { query, includeQmd, autoGraph, seeds })` returns a compact runtime resolver bundle with direct GBrain search, optional QMD broad lookup, and graph sidecar expansion.
- `renderRecallMarkdown(bundle)` renders a bundle into context-ready Markdown.
- `loadManagedRuntimeDescriptor(path)` validates the owner-only runtime descriptor and both pinned executables.
- `prepareManagedGbrainProvider(path)` returns the revalidated provider-native stdio invocation without proxying GBrain tools.
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

To score the actual runtime recall strategy, add `--compare-recall`:

```bash
node scripts/jarvos-gbrain.js eval \
  --eval-file /path/to/eval-questions.json \
  --compare-qmd \
  --compare-graph \
  --compare-recall
```

The `gbrain_recall` engine runs the recall bundle and checks its combined
Markdown output. If a question does not define explicit `recall` expectations,
the recall engine treats the GBrain, QMD, and graph expectations as acceptable
evidence candidates. This lets the eval distinguish direct-search gaps from
runtime recall failures.

With `--compare-recall`, direct `gbrain` remains an explicit diagnostic
comparator; the health-bearing result is `gbrain_recall` together with any
requested QMD and graph checks. A direct-search miss is therefore visible but
does not override a successful combined recall result. Expected phrases compare
after Unicode, punctuation, and whitespace normalization while preserving word
order and adjacency. Evaluation uses a top-10 candidate depth by default; the
interactive runtime recall bundle keeps its compact top-5 default.

For durable private diagnostics, add `--result-artifact <path>`. The 0600 JSON
artifact records the corpus digest, public and runtime revisions, engine
summaries, and only sanitized failed-question evidence: stable question IDs and
expected/actual candidate digests. It never stores query, answer, candidate, or
path text. Use `--public-revision` and `--runtime-revision` when the surrounding
runner has stronger revision authority than the evaluator's local Git checkout
and `OPENCLAW_RUNTIME_REVISION` environment.

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

## Maintenance Loop

`@jarvos/gbrain` is strongest when it is operated as a curated, evaluated layer
instead of a full-vault mirror. A runtime or local workspace can wrap this module
in a daily maintenance job with these steps:

1. Refresh the broad vault index through QMD or the runtime's memory-index
   command.
2. Run `gbrain stats` and `gbrain doctor --fast --json`.
3. Run the private combined eval:

```bash
node scripts/jarvos-gbrain.js eval \
  --eval-file /path/to/private-eval-questions.json \
  --compare-qmd \
  --compare-graph \
  --compare-recall
```

4. Scan recently edited vault notes for likely promotion candidates.
5. Record candidates in the user's tracker or maintenance report.
6. Generate a daily readable audit that explains the health of the stack in
   user-facing language: QMD freshness, GBrain health, memory-wiki health,
   combined recall eval result, scheduling state, changes, attention items, and
   improvement opportunities.

The audit should distinguish "the last report was healthy" from "today's
maintenance actually ran." If the scheduled maintenance job was skipped,
degraded, disabled, stale, or delivery failed, the report should say so plainly
even when the previous memory report passed.

The loop should be report-only for candidates. It should never write new pages
into the GBrain repo or mutate the user's vault unless a human has approved the
candidate and added it to the curated import manifest.

### Embedding Provider Changes

`gbrain embed --stale` writes vectors into the live GBrain store. Do not run it
after changing embedding providers until the store and model dimensions are
known to be compatible.

Use this preflight before switching providers:

1. Capture `gbrain stats` and `gbrain doctor --json`.
2. Run the private retrieval eval with `--compare-qmd --compare-graph
   --compare-recall`.
3. Back up the GBrain database directory.
4. Probe the target model and record its embedding dimensions.
5. If dimensions differ from the current store, reinitialize or migrate the
   vector store intentionally; do not mix dimensions in place.
6. Run `gbrain embed --stale`.
7. Re-run doctor, stats, and the same retrieval eval.
8. Keep the backup until the after-state is at least as good as the baseline.

For private local-first deployments, Ollama `mxbai-embed-large` is a reasonable
candidate, but it is still a migration when the existing store was initialized
with a different dimension model such as an OpenAI embedding model.

## Role in the jarvOS Architecture

`@jarvos/gbrain` is the structured knowledge layer. It does not replace QMD or
OpenClaw memory-wiki:

- QMD remains the broad, fast vault lookup path.
- memory-wiki remains a native OpenClaw compiled wiki and diagnostic dashboard.
- GBrain becomes the graph-like source for people, companies, projects, concepts,
  meetings, source pages, and other structured knowledge that should survive
  across runtimes.
