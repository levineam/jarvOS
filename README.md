# jarvOS

**A personal AI operating system. Cross-platform. Portable. Yours.**

---

jarvOS is a behavioral and knowledge layer for AI assistants. It gives an agent persistent identity, durable memory, a structured worldview, and the governance rules to act on your behalf without losing the plot between sessions.

It is **not** a runtime. jarvOS rides on top of an existing agent runtime — today [OpenClaw](https://github.com/openclaw/openclaw) ([openclaw.ai](https://openclaw.ai)) or [Hermes Agent](https://github.com/NousResearch/hermes-agent) — and uses your existing tools (Obsidian, Paperclip, etc.) as backing stores. The same jarvOS core works across runtimes; only the adapter changes.

## What's in this repo

```
jarvOS/
├── core/              # Portable behavioral layer (AGENTS.md, SOUL.md, IDENTITY.md, governance, pms)
├── modules/           # The jarvOS-owned npm modules
│   ├── jarvos-secondbrain/   # Content layer — journal, notes, capture routing
│   ├── jarvos-memory/        # Agent-state memory contract
│   ├── jarvos-ontology/      # Worldview / belief graph
│   ├── jarvos-gbrain/        # Structured knowledge bridge for GBrain
│   └── jarvos-agent-context/ # Runtime-facing recall/action adapter + MCP tools
├── templates/         # Blank starting points (USER, MEMORY, ONTOLOGY, TOOLS, AGENTS, BOOTSTRAP, HEARTBEAT)
├── runtimes/
│   ├── openclaw/      # OpenClaw adapter notes + setup script
│   ├── hermes/        # Hermes adapter notes + setup script
│   └── codex/         # Codex CLI MCP adapter notes + setup script
├── starter-kit/       # Governance workflow templates and project-management scaffolding
├── docs/              # Architecture, operations, ADRs
└── scripts/smoke-test.sh   # Verifies a fresh clone is intact
```

Everything jarvOS-owned is plain markdown plus a small amount of generic Node.js code in `modules/`. There is no database, no cloud service, and no proprietary format.

## Architecture: layers, not a stack

jarvOS is organized as seven layers, each with a clear owner. Mixing layers — putting a journal entry in memory, or a goal in your notes — is the most common way to break the system.

| Layer       | Owner                  | Typical content                                     |
| ----------- | ---------------------- | --------------------------------------------------- |
| Content     | `@jarvos/secondbrain`  | Journal entries, notes, raw capture                 |
| Recall      | `@jarvos/memory`       | Lessons, decisions-with-rationale, preferences, facts |
| Worldview   | `@jarvos/ontology`     | Beliefs, predictions, goals, projects, core self    |
| Structured knowledge | `@jarvos/gbrain` | People, companies, projects, concepts, meetings, source pages |
| Behavior    | `core/` (this repo)    | Identity, persona, rules, governance, PMS           |
| Execution   | Paperclip (dependency) | Tasks, issues, assignments, done/not-done           |
| Runtime     | OpenClaw, Hermes, Codex, etc. | Scheduling, tool execution, messaging, model calls  |

Read top to bottom: raw capture flows up into memory, ontology, and structured knowledge; the behavioral layer reads the relevant surfaces to decide how to act; the runtime executes those decisions; Paperclip records what got done. No layer reaches around its neighbors.

### The jarvOS modules

The `modules/` directory contains the runnable parts of jarvOS. Each module is a standalone npm package with its own README — see [`modules/README.md`](./modules/README.md) for the full breakdown.

- **[`@jarvos/secondbrain`](./modules/jarvos-secondbrain/)** — content-facing monorepo. Journal maintenance, notes management, capture routing, and an Obsidian storage adapter (plus adapter notes for OpenClaw). All paths are env-var driven via `bridge/config/jarvos-paths.js`. Your actual notes never live here; they stay in your vault.
- **[`@jarvos/memory`](./modules/jarvos-memory/)** — schema and audit tooling for agent-state memory. Defines what a `MEMORY.md` record looks like, how items get promoted, and how to validate a memory file against the contract. Your actual memories stay private and local.
- **[`@jarvos/ontology`](./modules/jarvos-ontology/)** — reader/writer/validator/renderer for the six-layer ontology (higher-order principles, beliefs, predictions, core self, goals, projects). Ships blank templates (`schema/templates/`) and heuristics (`schema/heuristics.md`), plus a Paperclip sync script (`scripts/sync-to-paperclip.js`). Your filled-in beliefs and goals stay private and local.
- **[`@jarvos/gbrain`](./modules/jarvos-gbrain/)** — curated bridge from an Obsidian-compatible vault into GBrain pages. It generates structured people, companies, projects, concepts, meetings, and source pages with provenance, then wraps GBrain sync/embed, retrieval eval, graph recall, and runtime recall-bundle commands.
- **[`@jarvos/agent-context`](./modules/jarvos-agent-context/)** — runtime-facing adapter for agent clients. It exposes current work, recall, startup brief, and verified note creation through a shared library and local stdio MCP server.

### Portable core + templates

The `core/` and `templates/` directories are pure markdown. They define **how an agent should think, communicate, and self-govern** without making any assumption about what runtime it runs on.

- `core/AGENTS.md` — behavioral rules
- `core/SOUL.md` — personality and tone
- `core/IDENTITY.md` — agent identity
- `core/governance/`, `core/pms/` — governance philosophy and project-management model
- `templates/*.md` — blank `USER.md`, `MEMORY.md`, `ONTOLOGY.md`, `TOOLS.md`, etc., that you fill in for yourself

### Runtime adapters

The `runtimes/` directory is the **only** place where jarvOS knows about a specific agent platform. Each adapter is small on purpose: it copies the portable core into the runtime's expected layout and fills in any glue the runtime requires. See [`runtimes/openclaw/README.md`](./runtimes/openclaw/README.md) and [`runtimes/hermes/README.md`](./runtimes/hermes/README.md) for the per-runtime checklists.

## What jarvOS owns vs. what it depends on

A common confusion is which behavior is jarvOS and which comes from the runtime or a dependency. The split is explicit.

### Owned by jarvOS (this repo)

- The behavioral layer: `AGENTS.md`, `SOUL.md`, `IDENTITY.md`, governance rules, PMS model
- The modules: `@jarvos/secondbrain`, `@jarvos/memory`, `@jarvos/ontology`, `@jarvos/gbrain`, `@jarvos/agent-context`
- The templates and starter-kit
- The adapter glue in `runtimes/`
- Cross-runtime invariants: layer boundaries, ontology heuristics, memory promotion rules, the public/private boundary documented in [`PUBLIC_BASELINE.md`](./PUBLIC_BASELINE.md)

### Provided by **OpenClaw** (runtime dependency)

OpenClaw is a separate project: <https://github.com/openclaw/openclaw> (homepage: [openclaw.ai](https://openclaw.ai)).

- Agent runtime: scheduling, heartbeat ticks, tool execution, multi-channel messaging, the `openclaw gateway` process
- Workspace bootstrap loading (`AGENTS.md`, `TOOLS.md`, `HEARTBEAT.md`, etc. on every turn)
- Lobster workflow gates that jarvOS plugs governance into

OpenClaw ships **blank** behavioral templates. jarvOS fills in the behavioral layer; OpenClaw runs it.

### Provided by **Hermes Agent** (runtime dependency)

Hermes is a separate project: <https://github.com/NousResearch/hermes-agent>.

- Agent runtime: model and API-key configuration, session management, tool calling
- Native learning and recall: skill auto-creation, configurable memory nudges, FTS5 session search with LLM summarization
- Honcho-based dialectic user modeling

Because Hermes already does learning, search, and user modeling natively, the Hermes adapter is intentionally lean — jarvOS only adds the behavioral layer and gets out of the way. Do not duplicate Hermes-native systems in jarvOS rules; see [`runtimes/hermes/README.md`](./runtimes/hermes/README.md) for the explicit "do not duplicate" table.

### Provided by **Obsidian / QMD / lossless-claw** (vault dependency)

- Obsidian: the markdown vault application and file format
- QMD: fast local search and exact lookup across the vault
- `lossless-claw`: the lossless-capture pipeline that writes into the vault

`@jarvos/secondbrain` reads from and writes to this vault through its `adapters/obsidian/` adapter; it does not own the vault format or the capture pipeline.

### Provided by **GBrain** (structured knowledge dependency)

GBrain is a separate local knowledge base and graph layer. `@jarvos/gbrain`
does not implement GBrain itself; it prepares curated, provenance-rich markdown
pages and wraps the installed `gbrain` CLI for sync, embedding, doctor, and
retrieval-eval workflows.

The recommended jarvOS operating pattern is:

1. Keep the Obsidian-compatible vault as the human-readable source of truth.
2. Use QMD for broad, fast vault lookup and exact note retrieval.
3. Use `@jarvos/gbrain` to import only a curated allowlist into GBrain.
4. Use GBrain direct search for structured recall and graph recall for linked
   people, projects, concepts, meetings, and sources.
5. Use the runtime recall bundle (`jarvos-gbrain recall --query ...`) as the
   call surface an agent runtime can invoke before deciding what context to
   inject.

The public repo ships template manifests and eval fixtures only. Real manifests,
eval questions, generated private pages, and personal notes stay in your local
workspace.

A production OpenClaw setup should add a conservative maintenance loop around
these tools: refresh QMD/OpenClaw memory indexes, run GBrain and memory-wiki
health checks, run combined recall evals, and propose new GBrain promotion
candidates for human review. The loop should not auto-promote notes into
GBrain; approved additions still flow through the curated manifest and normal
import/sync path.

Embedding maintenance should be handled with the same discipline. Treat an
embedding model change as a data migration, not a provider toggle: capture
`gbrain stats`, run `gbrain doctor --json`, back up the GBrain database, confirm
the new model's vector dimensions, then run before/after retrieval evals. Local
Ollama models such as `mxbai-embed-large` can be a good private default, but
only after the live GBrain store is reinitialized or migrated for that model's
dimensions.

For human trust, pair that quiet loop with a daily readable audit. The audit
should explain, in plain language, whether QMD refreshed, whether GBrain and
memory-wiki are healthy, whether the combined recall eval still passes, what
changed, what needs attention, and what improvement candidates are worth
reviewing. The report is the user-facing assurance layer; the maintenance loop
is the machine-facing work layer.

OpenClaw `memory-wiki` is also separate from jarvOS. In this architecture it is
treated as a native OpenClaw diagnostic and compiled-wiki layer, not the primary
source for GBrain-ready graph discipline.

### Provided by **Paperclip** (execution-tracking dependency)

- Issues, projects, assignments, status transitions, comments, approvals, heartbeats
- The execution-side source of truth for "what did the agent actually do"
- Sync target for `@jarvos/ontology` projects via `scripts/sync-to-paperclip.js` in that module

jarvOS does not implement task tracking. When work needs to happen, ontology projects are synced into Paperclip and Paperclip drives execution.

### Other dependencies

- **Node.js ≥ 18** for the modules and the bootstrap script
- The runtime's own dependencies (model providers, API keys) — owned by the runtime, not by jarvOS

## Quick start

### Verify your clone is complete

```bash
git clone https://github.com/levineam/jarvOS.git
cd jarvOS
bash scripts/smoke-test.sh
# Expected: "PASS — All checks passed. The repo is ready to use."
```

The smoke test takes under a second, requires no external tools, and runs in CI on every PR.

### Hermes Agent

```bash
hermes setup                          # Hermes itself: configure model and API keys
./runtimes/hermes/setup.sh            # jarvOS: install behavioral layer into Hermes workspace
# Fill in USER.md and ONTOLOGY.md with your info
hermes                                # Start chatting
```

See [`runtimes/hermes/README.md`](./runtimes/hermes/README.md) for full setup details and the list of Hermes-native systems jarvOS deliberately avoids duplicating.

### OpenClaw

**Prerequisites:** Node.js ≥ 18 and OpenClaw (`npm install -g openclaw`).

```bash
# Copy the portable core into your OpenClaw workspace
cp core/AGENTS.md    /path/to/your/openclaw-workspace/AGENTS.md
cp core/SOUL.md      /path/to/your/openclaw-workspace/SOUL.md
cp core/IDENTITY.md  /path/to/your/openclaw-workspace/IDENTITY.md
cp templates/BOOTSTRAP-template.md /path/to/your/openclaw-workspace/BOOTSTRAP.md
cp templates/HEARTBEAT-template.md /path/to/your/openclaw-workspace/HEARTBEAT.md
# Create USER.md and ONTOLOGY.md from the templates and fill them in, then:
cd /path/to/your/openclaw-workspace
openclaw gateway start
```

See [`runtimes/openclaw/README.md`](./runtimes/openclaw/README.md) for the full adapter wiring checklist (`TOOLS.md`, `CONSTITUTION.md`, `scripts/`, `workflows/`) and the bootstrap-budget guidance for keeping always-loaded files compact.

### Codex CLI

```bash
./runtimes/codex/setup.sh
```

This registers the local `jarvos` MCP server so Codex can call jarvOS recall,
current-work, and note-capture tools.

### Use the modules

The modules can be installed independently from a clone of this repo:

```bash
npm install ./modules/jarvos-memory ./modules/jarvos-ontology ./modules/jarvos-secondbrain ./modules/jarvos-gbrain ./modules/jarvos-agent-context
```

Each has its own quick-start in [`modules/README.md`](./modules/README.md).

## Documentation

- [`PUBLIC_BASELINE.md`](./PUBLIC_BASELINE.md) — what is and is not in this repo (public/private boundary)
- [`modules/README.md`](./modules/README.md) — module-by-module reference
- [`runtimes/openclaw/README.md`](./runtimes/openclaw/README.md) — OpenClaw adapter checklist
- [`runtimes/hermes/README.md`](./runtimes/hermes/README.md) — Hermes adapter checklist
- [`starter-kit/README.md`](./starter-kit/README.md) — starter-kit setup and rollout checklist
- `docs/architecture/` — architecture overview, ADRs, operating model

## Distribution

jarvOS is distributed as a plain git repo. No npm publish, no build step, no install manager required. Clone it and use it.

**Why a single flat repo?**

- The portable layer is markdown — there is nothing to compile or link.
- Each runtime provides its own setup path (`setup.sh` for Hermes, copy-and-wire for OpenClaw).
- Keeping core, modules, and adapters in one repo means you can fork it, modify it, and sync upstream changes with standard git.

**Staying up to date:**

```bash
cd jarvOS
git pull origin main
bash scripts/smoke-test.sh   # Verify everything is still intact after the pull
```

## Philosophy

- **Code is public. Content is private.** The repo ships generic templates and tooling; your beliefs, goals, memories, and journal stay in your local workspace.
- **Layers, not features.** Content, recall, worldview, structured knowledge, behavior, execution, and runtime each have a single owner. Don't mix them.
- **Portable over proprietary.** The behavioral layer must run on any agent runtime that loads project context files.
- **Generic over specific.** Prefer patterns that survive a runtime change over platform hacks that don't.
- **Behaviors are on by default.** Turn things off when they don't fit.

## Follow along

The creator shares how he uses and develops jarvOS on X: [@andrarchy](https://x.com/andrarchy).

If you build something on top of this, open an issue or find him there.
