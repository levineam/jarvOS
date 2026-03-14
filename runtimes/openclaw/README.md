# jarvOS — OpenClaw Runtime

This directory contains OpenClaw-specific implementation files for jarvOS.

## What's Here

OpenClaw provides powerful scheduling, tool execution, and multi-channel messaging — but ships with blank templates. jarvOS fills the behavioral layer.

This folder currently ships as **documentation-only** (this README). The actual starter files live in repo root (`core/` and `templates/`) and are copied into your OpenClaw workspace.

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

This repo does **not** ship OpenClaw runtime scripts in `runtimes/openclaw/` yet. Use the [PMS session lifecycle pattern](../../core/pms/session-lifecycle.md) as a reference when you build your own workspace scripts.

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

## What OpenClaw Handles Natively

OpenClaw does NOT have built-in learning loops. jarvOS adds:
- Memory maintenance via HEARTBEAT.md
- Daily memory files (`memory/YYYY-MM-DD.md`)
- CIL (Continuous Integration of Learning) loop
- Reflection passes
- Custom skill governance

These are OpenClaw-specific because Hermes handles them natively.
