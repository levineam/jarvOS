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
- **Alignment** — every project traces back to your goals and values via `ONTOLOGY.md`
- **Proactive work** — briefings, task execution, email monitoring, calendar awareness

## Architecture: Core + Runtime

jarvOS separates **what the agent believes and how it behaves** (portable) from **how it executes** (runtime-specific).

```text
jarvOS/
├── core/                    # Portable behavioral layer
│   ├── AGENTS.md            # Behavioral rules (works on any runtime)
│   ├── SOUL.md              # Personality and tone
│   └── IDENTITY.md          # Agent identity
├── templates/               # Workspace seed files you fill in
│   ├── AGENTS-template.md
│   ├── BOOTSTRAP-template.md
│   ├── HEARTBEAT-template.md
│   ├── USER.template.md
│   ├── MEMORY.template.md
│   ├── ONTOLOGY.template.md
│   └── TOOLS.template.md
├── runtimes/
│   ├── openclaw/            # OpenClaw-specific adapter docs
│   └── hermes/              # Hermes-specific setup + skill
├── starter-kit/             # Optional portable extras
└── docs/                    # Architecture and reference docs
```

**Core** is the behavioral backbone — rules, principles, persona, governance philosophy. It's pure markdown with zero runtime assumptions. It works on any AI agent that loads project context files.

**Runtimes** wire those principles into specific platforms:
- **OpenClaw** adds adapter wiring, heartbeat automation patterns, and custom memory / workflow guidance
- **Hermes** is deliberately lean — Hermes has native skill creation, memory nudges, session search, and user modeling, so jarvOS just provides the behavioral layer and lets Hermes handle the mechanism

## Quick start

### Hermes Agent

```bash
git clone https://github.com/levineam/jarvOS.git
cd jarvOS
hermes setup   # Configure model and API keys (creates ~/.hermes/config.yaml)
./runtimes/hermes/setup.sh   # Installs jarvOS and attempts to set Hermes terminal.cwd to this workspace
# Edit USER.md and ONTOLOGY.md with your info
hermes         # Start chatting
```

### OpenClaw

```bash
git clone https://github.com/levineam/jarvOS.git
cd jarvOS
# Copy core/ files into your OpenClaw workspace, then follow runtimes/openclaw/README.md for runtime adapter wiring
# Copy the relevant templates into that workspace and fill in your details
cp templates/BOOTSTRAP-template.md /path/to/your/openclaw-workspace/BOOTSTRAP.md
# Tell your assistant (in that workspace) to read BOOTSTRAP.md
cd /path/to/your/openclaw-workspace
openclaw gateway start
```

The `BOOTSTRAP.md` copy above is just one example. For a real OpenClaw workspace, also copy and customize the other relevant files from `templates/` (for example `AGENTS`, `HEARTBEAT`, `USER`, `MEMORY`, `ONTOLOGY`, and `TOOLS`) plus any core persona files you want to adopt.

## The five systems

1. **Project Management** — Portfolios → Programs → Project Boards → Tasks. Your assistant works from “Autonomous Now” without being asked, routes blockers through “Needs You”, and doesn’t confuse the two.
2. **Governance** — Compliance scanning, milestone gates, OKR integration. When a project drifts from its goals, the system flags it. Decisions queue with an escalation ladder.
3. **`ONTOLOGY.md`** — The “why” layer. Maps your beliefs, mission, values, and goals. Every project should trace back to a goal. Orphan detection flags disconnected work.
4. **Continuous Learning & Execution** — Autonomous work loops, briefings, reflection passes. On OpenClaw this is custom-built via scripts; on Hermes it is mostly native.
5. **Security** — Automated version checks, external messaging approval gates, and secret-handling rules.

## What's currently shipped

### Core behavior files

| File | Purpose |
|------|---------|
| `core/AGENTS.md` | Portable operating rules and autonomy boundaries |
| `core/SOUL.md` | Personality, tone, and style |
| `core/IDENTITY.md` | Identity scaffold for the assistant |

### Templates

| File | Purpose |
|------|---------|
| `templates/AGENTS-template.md` | Workspace behavior file for runtimes that want a local copy |
| `templates/BOOTSTRAP-template.md` | First-run instructions |
| `templates/HEARTBEAT-template.md` | Proactive check-in / scheduler prompt |
| `templates/USER.template.md` | About the human |
| `templates/MEMORY.template.md` | Long-term memory seed |
| `templates/ONTOLOGY.template.md` | Values, beliefs, goals, and project alignment |
| `templates/TOOLS.template.md` | Local tool notes and guardrails |
| `templates/okr-task-board-template.md` | Reusable OKR-linked task board |
| `templates/project-kickoff-pack-template.md` | Reusable kickoff pack for project setup |

### Runtime adapters

| Path | Purpose |
|------|---------|
| `runtimes/hermes/README.md` | Hermes runtime notes |
| `runtimes/hermes/setup.sh` | Hermes workspace/setup bootstrap |
| `runtimes/hermes/skills/jarvos/SKILL.md` | Hermes skill for jarvOS |
| `runtimes/openclaw/README.md` | OpenClaw runtime adapter guidance |

### Starter kit and references

- `starter-kit/README.md` — portable starter-kit setup notes
- `starter-kit/templates/` — mirrored planning templates
- `starter-kit/workflows/basic-ci.yml` — starter automation example
- `docs/architecture/jarvos-architecture.md` — architecture overview and operating model
- `docs/architecture/architecture-decision-records/architecture-decision-record-20260219-ars-contexta-patterns.md` — architecture decision context

## Public baseline status

This repo is the public baseline candidate for jarvOS core + runtime adapters.

Before treating it as a production baseline, verify:
1. README and runtime docs stay aligned with the files actually shipped here.
2. `docs/meta/source-to-export-map.json` stays sanitized (relative/public-safe paths only).
3. A clean canary workspace works on both Hermes and OpenClaw.
4. Your local persona / memory / ontology files are actually filled in for the target user.
5. Public-facing docs and runtime behavior stay coherent when new adapters or templates land.

## Philosophy

- Behaviors are on by default. Turn things off when they don't fit.
- Everything is markdown. No database, no cloud service, no proprietary format.
- If a behavior can run without pulling you in, it should. If it can't, it surfaces a clear ask with a recommended default.
- **Generic over specific.** Prefer portable patterns over platform hacks.
- **Portable over proprietary.** Solutions should work with any AI runtime.

## Follow along

The creator shares how he uses and develops jarvOS on X: [@andrarchy](https://x.com/andrarchy).

If you build something on top of this, open an issue or find him there.
