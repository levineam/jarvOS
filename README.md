# jarvOS

**A personal AI operating system. Cross-platform. Portable. Yours.**

---

jarvOS is a behavioral and knowledge layer for AI assistants. It gives an agent persistent identity, durable memory, a structured worldview, and the governance rules to act on your behalf without losing the plot between sessions.

It is **not** a runtime. jarvOS rides on top of an existing agent runtime — today [OpenClaw](https://github.com/openclaw/openclaw) ([openclaw.ai](https://openclaw.ai)) or [Hermes Agent](https://github.com/NousResearch/hermes-agent) — and uses your existing tools (Obsidian, Paperclip, etc.) as backing stores. The same jarvOS core works across runtimes; only the adapter changes.

## What's in this repo

```
jarvOS/
├── core/              # Portable behavioral layer (AGENTS.md, SOUL.md, IDENTITY.md, governance, pms)
├── modules/           # The three jarvOS-owned npm modules
│   ├── jarvos-secondbrain/   # Content layer — journal, notes, capture routing
│   ├── jarvos-memory/        # Agent-state memory contract
│   └── jarvos-ontology/      # Worldview / belief graph
├── templates/         # Blank starting points (USER, MEMORY, ONTOLOGY, TOOLS, AGENTS, BOOTSTRAP, HEARTBEAT)
├── runtimes/
│   ├── openclaw/      # OpenClaw adapter notes + setup script
│   └── hermes/        # Hermes adapter notes + setup script
├── starter-kit/       # Governance workflow templates and project-management scaffolding
├── docs/              # Architecture, operations, ADRs
└── scripts/smoke-test.sh   # Verifies a fresh clone is intact
```

Everything jarvOS-owned is plain markdown plus a small amount of generic Node.js code in `modules/`. There is no database, no cloud service, and no proprietary format.

## Architecture: layers, not a stack

jarvOS is organized as six layers, each with a clear owner — three owned by this repo, three provided by dependencies. Mixing layers — putting a journal entry in memory, or a goal in your notes — is the most common way to break the system.

| Layer       | Owner                  | Typical content                                     |
| ----------- | ---------------------- | --------------------------------------------------- |
| Content     | `@jarvos/secondbrain`  | Journal entries, notes, raw capture                 |
| Recall      | `@jarvos/memory`       | Lessons, decisions-with-rationale, preferences, facts |
| Worldview   | `@jarvos/ontology`     | Beliefs, predictions, goals, projects, core self    |
| Behavior    | `core/` (this repo)    | Identity, persona, rules, governance, PMS           |
| Execution   | Paperclip (dependency) | Tasks, issues, assignments, done/not-done           |
| Runtime     | OpenClaw or Hermes     | Scheduling, tool execution, messaging, model calls  |

Read top to bottom: raw capture flows up into memory and ontology; the behavioral layer reads all three to decide how to act; the runtime executes those decisions; Paperclip records what got done. No layer reaches around its neighbors.

### The three jarvOS modules

The `modules/` directory contains the runnable parts of jarvOS. Each module is a standalone npm package with its own README — see [`modules/README.md`](./modules/README.md) for the full breakdown.

- **[`@jarvos/secondbrain`](./modules/jarvos-secondbrain/)** — content-facing monorepo. Journal maintenance, notes management, capture routing, and an Obsidian storage adapter (plus adapter notes for OpenClaw). All paths are env-var driven via `bridge/config/jarvos-paths.js`. Your actual notes never live here; they stay in your vault.
- **[`@jarvos/memory`](./modules/jarvos-memory/)** — schema and audit tooling for agent-state memory. Defines what a `MEMORY.md` record looks like, how items get promoted, and how to validate a memory file against the contract. Your actual memories stay private and local.
- **[`@jarvos/ontology`](./modules/jarvos-ontology/)** — reader/writer/validator/renderer for the six-layer ontology (higher-order principles, beliefs, predictions, core self, goals, projects). Ships blank templates (`schema/templates/`) and heuristics (`schema/heuristics.md`), plus a Paperclip sync script (`scripts/sync-to-paperclip.js`). Your filled-in beliefs and goals stay private and local.

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
- The three modules: `@jarvos/secondbrain`, `@jarvos/memory`, `@jarvos/ontology`
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
- QMD (Obsidian-compatible vault layout): how journal and notes are organized on disk
- `lossless-claw`: the lossless-capture pipeline that writes into the vault

`@jarvos/secondbrain` reads from and writes to this vault through its `adapters/obsidian/` adapter; it does not own the vault format or the capture pipeline.

### Provided by **Paperclip** (execution-tracking dependency)

- Issues, projects, assignments, status transitions, comments, approvals, heartbeats
- The execution-side source of truth for "what did the agent actually do"
- Sync target for `@jarvos/ontology` projects via `scripts/sync-to-paperclip` in that module

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

### Use the modules

The three modules can be installed independently from a clone of this repo:

```bash
npm install ./modules/jarvos-memory ./modules/jarvos-ontology ./modules/jarvos-secondbrain
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
- **Layers, not features.** Content, recall, worldview, behavior, execution, and runtime each have a single owner. Don't mix them.
- **Portable over proprietary.** The behavioral layer must run on any agent runtime that loads project context files.
- **Generic over specific.** Prefer patterns that survive a runtime change over platform hacks that don't.
- **Behaviors are on by default.** Turn things off when they don't fit.

## Follow along

The creator shares how he uses and develops jarvOS on X: [@andrarchy](https://x.com/andrarchy).

If you build something on top of this, open an issue or find him there.
