# jarvOS — OpenClaw Runtime

This directory contains the public OpenClaw adapter declaration, setup contract,
and stable jarvOS stewardship plugin tuple for jarvOS.

## Checked-in adapter status

`openclaw-workspace` uses manual hydration. This repository provides the public
adapter checklist below, but does not ship an OpenClaw MCP registration or a
startup hook; local workspace adapters remain responsible for that integration.

## What's Here

OpenClaw provides powerful scheduling, tool execution, and multi-channel messaging — but ships with blank templates. jarvOS fills the behavioral layer.

The starter files live in repo root (`core/` and `templates/`) and are copied
into your OpenClaw workspace. The managed stewardship plugin is a separate,
durable runtime asset; it is not copied into OpenClaw's managed npm project.

Startup hydration is manual: call the `jarvos_hydrate` MCP tool when a session needs the current context packet.

Use this as an adapter checklist for files you place in your workspace root:

- **HEARTBEAT.md** — start from `templates/HEARTBEAT-template.md`
- **TOOLS.md** — create this in your workspace (tool CLI notes + local operational patterns)
- **AGENTS.md / SOUL.md / IDENTITY.md** — copy from `core/`
- **CONSTITUTION.md / CRITICAL-RULES.md** — create for your runtime-specific routing and safety rules
- **scripts/** — operational scripts (governance, briefing, cron management, etc.)
- **workflows/** — approval workflows for high-stakes actions

## Setup

1. Install [OpenClaw](https://github.com/openclaw/openclaw)
2. Clone this repo into your workspace directory
3. Copy `core/` files to your workspace root
4. Copy templates and fill in your personal details
5. Create/apply the OpenClaw adapter files in your workspace (HEARTBEAT.md, TOOLS.md, CONSTITUTION.md, scripts/, workflows/)
6. Run `openclaw gateway start`

The ordinary setup path prepares a workspace. An explicitly activated managed
launcher may also run this adapter's `setup.sh` in stewardship-only mode. That
path registers the stable jarvOS plugin with a backed-up, atomic configuration
merge, verifies the registration with OpenClaw's read-only inspection command,
and restores the exact prior configuration if its new registration cannot be
verified. It does not install the staged jarvOS plugin into an OpenClaw-managed
npm root.

## Plugin persistence and cleanup

OpenClaw-managed plugin projects are durable software, not cache. A cleanup job
must not delete a managed npm project, a configured path-loaded plugin, or a
jarvOS staged adapter because a package inventory looks stale.

Use OpenClaw's supported structured surfaces to discover what must be preserved:

```bash
openclaw plugins registry --json
openclaw plugins inspect --all --json
```

Treat the registry's current plugin roots, install-record paths, sources, and
manifest paths as the protected set for that observation. The paths are
installation-specific, so do not assume one home-directory layout. Keep the
raw output local; summaries and issue reports should contain counts and
classification only.

Before cleanup, record a bounded plugin count and run the local jarvOS doctor.
After cleanup, run the same read-only commands and doctor again. A cleanup
allowlist may cover only its own temporary/cache roots; it must explicitly
exclude registry-derived protected roots and the jarvOS staged runtime root.
Never edit OpenClaw's generated registry database or index by hand, and do not
run a broad automatic repair from a scheduled job.

When drift is reported, inspect the affected plugin id and package/path first.
Use the official OpenClaw command appropriate to the confirmed scope, such as
`openclaw plugins install <package-or-path>` or
`openclaw plugins enable <plugin-id>`, then rerun inspection. For the jarvOS
adapter, rerun the supported setup path; do not repair unrelated plugins on
jarvOS's authority.

The jarvOS doctor uses these bounded states:

- `ok`: the observed registry, inspection, filesystem, and version evidence is
  coherent and the staged jarvOS adapter is present.
- `warn`: unrelated plugin drift or incomplete/uncertain evidence needs review.
- `fail`: the enabled jarvOS staged adapter is missing or the required local
  runtime cannot be used.
- `skipped`: the installed OpenClaw version does not expose the supported
  structured capability, so no repair or rollback was attempted.

## Bootstrap Budget Management

OpenClaw loads bootstrap files (AGENTS.md, TOOLS.md, HEARTBEAT.md, MEMORY.md, etc.) on **every turn**. This consumes context budget — attention degrades as files grow, and large files suffer "lost-in-middle" effects above ~20K chars.

**The pattern:** Keep always-loaded files compact. Extract detailed procedures, code blocks, and full specifications into `references/` files that are loaded on-demand.

```
workspace/
├── HEARTBEAT.md                        # Compact checklist (~5K chars)
├── references/
│   └── heartbeat-procedures.md         # Full procedures (~16K chars, loaded when needed)
└── ...
```

**How it works:**
1. HEARTBEAT.md contains a concise checklist with section headers and one-line descriptions
2. Each section that has detailed procedures includes a pointer: `*(Details: references/heartbeat-procedures.md § Section N)*`
3. The agent reads the reference file only when executing that specific section
4. Result: ~70% reduction in always-loaded context with zero content loss

**Budget targets:**
- Individual files: keep under 13K chars (warn at 15K, hard limit at 20K)
- Total always-loaded: keep under 80% of model context budget
- Run `node scripts/context-watchdog.js` (coming soon) to check current status

**Anti-drift:** Schedule daily trend captures with `node scripts/context-budget-trend-capture.js` (coming soon) and run weekly governance reviews to catch gradual growth before it hits limits.

## Session Lifecycle — OpenClaw Reference Pattern

Use the [PMS session lifecycle pattern](../../core/pms/session-lifecycle.md) as
a reference when you build workspace scripts. The checked-in setup and
stewardship plugin files define only the portable adapter boundary; your
workspace remains responsible for any additional lifecycle wiring.

### Suggested Wiring (for your workspace)

- Keep lifecycle state in `memory/heartbeat-state.json` under a `sessionLifecycle` key.
- Refresh that snapshot from your reflection/watchdog flow.
- Let downstream scripts (task selection, briefing, reflection) read lifecycle state instead of re-scanning everything each time.

### Snapshot Fields

Use the full lifecycle contract from `core/pms/session-lifecycle.md`:
- `working_on`
- `blocked`
- `decisions`
- `next`
- `updated_at`
- `source`

### Freshness Guidance

- Default stale threshold: 2 hours
- Morning briefing can use 4 hours (relaxed startup window)
- If stale or missing, consumers should fall back cleanly

## Memory and Knowledge Wiring

For OpenClaw, jarvOS treats the user's Obsidian-compatible vault as the source
of truth and keeps retrieval tools in separate roles:

| Layer | Recommended owner | Purpose |
|-------|-------------------|---------|
| Human notes | Obsidian-compatible vault | Source notes, journals, clippings, and durable personal context |
| Broad lookup | QMD | Fast search and exact lookup across the full vault |
| Structured recall | GBrain via `@jarvos/gbrain` | Curated people, companies, projects, concepts, meetings, and source pages |
| Graph sidecar | GBrain graph commands | Cross-source recall once a likely seed page is known |
| Runtime diagnostics | OpenClaw `memory-wiki` | Native wiki status, lint, dashboards, synthesis, and handoff diagnostics |

The OpenClaw runtime should call the retrieval layer deliberately. A common
pattern is:

```bash
jarvos-gbrain recall \
  --query "What context should I know before answering this?" \
  --format markdown
```

Run it from a workspace where `@jarvos/gbrain` has been installed or with the
equivalent explicit path to your jarvOS clone. The command returns context-ready
Markdown, but it does not inject anything on its own. Your OpenClaw adapter
should decide when to call it and how much of the result belongs in the active
prompt.

### Conservative Memory-Ops Cron Pattern

For a production OpenClaw workspace, keep memory maintenance autonomous but
bounded:

- Run a daily isolated cron job that refreshes QMD/OpenClaw memory indexes.
- Keep QMD in search/BM25 mode unless you explicitly choose an embedding pass.
- Check GBrain with `gbrain stats` and `gbrain doctor --fast --json`.
- Check OpenClaw `memory-wiki` with `openclaw wiki status`, `doctor`, and
  `lint`.
- Run `@jarvos/gbrain` private evals with `--compare-qmd --compare-graph
  --compare-recall`.
- Propose GBrain promotion candidates in the user's tracker or a maintenance
  report, but do not auto-promote them.
- Send or surface a daily readable audit during rollout. It should name what
  passed, why each check matters, what changed, what needs user attention, and
  what can be improved next. This is separate from quiet maintenance output.
- Keep the audit noisy-first until the loop has earned trust. During rollout,
  deliver daily plain-English status to the human's normal attention channels
  and keep durable evidence in the tracker or local memory artifacts.
- Treat missed or preflight-skipped maintenance runs as visible attention items;
  a previous healthy report should not make today's audit look healthy if the
  scheduled maintenance job did not actually run.
- Treat GBrain embedding provider changes as migrations. Before moving to a
  local Ollama model such as `mxbai-embed-large`, back up GBrain, record current
  doctor/stats/eval evidence, verify the model's vector dimensions, reinitialize
  or migrate if dimensions differ, then rerun the same evals before calling the
  migration healthy.
- If prompt injection is enabled, keep it narrow: one known session or agent,
  low result count, strict character cap, short timeout, and an explicit
  untrusted-context wrapper.

This keeps the vault as the source of truth, QMD as broad lookup, GBrain as
curated structured recall, and memory-wiki as runtime diagnostics.

## Ontology Context

OpenClaw should load ontology through `jarvos_hydrate` or the shared
`@jarvos/ontology` provider when that MCP/tooling path is available. The
ontology packet is hierarchy-of-meaning context for values, motivations,
reviewed beliefs, goals, predictions, and project relationships. It is not
task state and not raw memory.

OpenClaw adapters must not directly mutate ontology source files or rewrite
`ONTOLOGY.md`. Source-backed secondbrain evidence can create ontology
candidates or inquiry items; promotion into active ontology requires review.

## Intentional Secondbrain Capture

OpenClaw is the reference adapter for deterministic note and journal behavior,
but jarvOS owns the contract. For `note:`, `make a note`, `idea:`, `save this`,
and similar explicit capture requests, OpenClaw should call:

```bash
node modules/jarvos-secondbrain/scripts/jarvos-capture.js
```

The capture event source is `openclaw`. Successful note captures must write
under the configured `Notes/` directory, link exactly once from
`Journal/YYYY-MM-DD.md`, preserve source-backed provenance, and leave QMD/search
freshness as `pending-refresh`. OpenClaw adapters should enforce this behavior
without becoming the owner of the abstraction, and they must not create guessed
daily journal files under `Notes/`.

## What jarvOS Adds On Top

OpenClaw handles the runtime and can provide native memory-wiki diagnostics.
jarvOS adds the opinionated operating loops:

- Memory maintenance via HEARTBEAT.md
- Daily memory files (`memory/YYYY-MM-DD.md`)
- CIL (Continuous Integration of Learning) loop
- Reflection passes
- Custom skill governance

These are OpenClaw-specific because Hermes handles them natively.
