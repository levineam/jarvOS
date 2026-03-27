# jarvOS

**A personal AI operating system. Cross-platform. Portable. Yours.**

---

jarvOS is a behavioral layer that makes AI assistants actually useful out of the box — with persistent identity, governance, proactive behavior, and alignment to what you care about.

It runs on [OpenClaw](https://openclaw.ai) and [Hermes Agent](https://github.com/NousResearch/hermes-agent). Same core, different runtimes.

## What jarvOS does

Most AI assistants are reactive. You ask, they answer. Close the chat, and they forget everything.

jarvOS changes the default:
- **Identity & persona** — your assistant knows who it is and how to communicate
- **Behavioral rules** — when to act autonomously, when to ask permission, when to plan first
- **Governance** — structured project tracking, milestone gates, escalation ladders
- **Alignment** — every project traces back to your goals and values via ONTOLOGY.md
- **Proactive work** — briefings, task execution, email monitoring, calendar awareness

## Architecture: Core + Runtime

jarvOS separates **what the agent believes and how it behaves** (portable) from **how it executes** (runtime-specific).

```
jarvOS/
├── core/                  # Portable behavioral layer
│   ├── AGENTS.md          # Behavioral rules (works on any runtime)
│   ├── SOUL.md            # Personality and tone
│   └── IDENTITY.md        # Agent identity
├── templates/             # You fill these in
│   ├── USER.template.md   # About you
│   ├── MEMORY.template.md # Long-term memory seed
│   ├── ONTOLOGY.template.md # Your values and goals
│   └── TOOLS.template.md  # Local tool notes + guardrails
├── runtimes/
│   ├── openclaw/          # OpenClaw-specific (scripts, workflows, heartbeat)
│   └── hermes/            # Hermes-specific (setup script, lean adapter)
└── docs/                  # Documentation and architecture
```

**Core** is the behavioral backbone — rules, principles, persona, governance philosophy. It's pure markdown with zero runtime assumptions. It works on any AI agent that loads project context files.

**Runtimes** wire those principles into specific platforms:
- **OpenClaw** adds scripts, Lobster workflow gates, heartbeat automation, and custom memory management (because OpenClaw doesn't have built-in learning loops)
- **Hermes** is deliberately lean — Hermes has native skill creation, memory nudges, session search, and user modeling, so jarvOS just provides the behavioral layer and lets Hermes handle the mechanism

## Quick start

### Verify your clone is complete

After cloning, run the smoke test to confirm all required files are present:

```bash
git clone https://github.com/levineam/jarvOS.git
cd jarvOS
bash scripts/smoke-test.sh
# Expected: "PASS — All checks passed. The repo is ready to use."
```

This takes under a second and requires no external tools. If it passes, you have a working jarvOS install.

### Hermes Agent

```bash
git clone https://github.com/levineam/jarvOS.git
cd jarvOS
bash scripts/smoke-test.sh           # Verify clone is complete
hermes setup                          # Configure model and API keys
./runtimes/hermes/setup.sh            # Install jarvOS into Hermes workspace
# Fill in USER.md and ONTOLOGY.md with your info
hermes                                # Start chatting
```

See `runtimes/hermes/README.md` for full setup details.

### OpenClaw

```bash
git clone https://github.com/levineam/jarvOS.git
cd jarvOS
bash scripts/smoke-test.sh           # Verify clone is complete
# Copy core/ files into your OpenClaw workspace
cp core/AGENTS.md    /path/to/your/openclaw-workspace/AGENTS.md
cp core/SOUL.md      /path/to/your/openclaw-workspace/SOUL.md
cp core/IDENTITY.md  /path/to/your/openclaw-workspace/IDENTITY.md
cp templates/BOOTSTRAP-template.md /path/to/your/openclaw-workspace/BOOTSTRAP.md
cp templates/HEARTBEAT-template.md /path/to/your/openclaw-workspace/HEARTBEAT.md
# Create USER.md and ONTOLOGY.md with your info, then:
cd /path/to/your/openclaw-workspace
openclaw gateway start
```

See `runtimes/openclaw/README.md` for the full adapter wiring checklist, including `TOOLS.md`, `CONSTITUTION.md`, `scripts/`, and `workflows/`.

## The five systems

1. **Project Management** — Portfolios → Programs → Project Boards → Tasks. Your assistant works from "Autonomous Now" without being asked, routes blockers through "Needs You", and doesn't confuse the two.

2. **Governance** — Compliance scanning, milestone gates, OKR integration. When a project drifts from its goals, the system flags it. Decisions queue with an escalation ladder.

3. **ONTOLOGY.md** — The "why" layer. Maps your beliefs, mission, values, and goals. Every project should trace back to a goal. Orphan detection flags disconnected work.

4. **Continuous Learning & Execution** — Autonomous work loops, briefings, reflection passes. On OpenClaw this is custom-built via scripts; on Hermes it's native.

5. **Security** — Automated version checks, external messaging approval gates, secret handling rules.

## Troubleshooting and rollout notes

- `starter-kit/README.md` — starter-kit setup and rollout checklist (export slug: `starter-kit/readme.md`)
- `docs/architecture/jarvos-architecture.md` — architecture overview and operating model
- `docs/architecture/architecture-decision-records/architecture-decision-record-20260219-ars-contexta-patterns.md` — architecture decision context

## Distribution

jarvOS is distributed as a plain git repo. No npm package, no build step, no install manager required. Clone it and use it.

**Why no submodules or package manager?**

- The core files are markdown — there is nothing to compile or link.
- Each runtime provides its own setup path (`setup.sh` for Hermes, copy-and-wire for OpenClaw).
- Keeping it as a single flat repo means you can fork it, modify it, and sync upstream changes with standard git.

**Staying up to date:**

```bash
cd jarvOS
git pull origin main
bash scripts/smoke-test.sh   # Verify everything is still intact after the pull
```

## Current dogfood baseline status

This repo is a **public docs and template baseline** and portable cross-runtime core. It is not a zero-config clone of Andrew's live workspace.

The smoke test (`scripts/smoke-test.sh`) validates the shipped state on every CI run. All 27+ checks must pass before a PR merges.

## Philosophy

- Behaviors are on by default. Turn things off when they don't fit.
- Everything is markdown. No database, no cloud service, no proprietary format.
- If a behavior can run without pulling you in, it should. If it can't, it surfaces a clear ask with a recommended default.
- **Generic over specific.** Prefer portable patterns over platform hacks.
- **Portable over proprietary.** Solutions should work with any AI runtime.

## Follow along

The creator shares how he uses and develops jarvOS on X: [@andrarchy](https://x.com/andrarchy).

If you build something on top of this, open an issue or find him there.
