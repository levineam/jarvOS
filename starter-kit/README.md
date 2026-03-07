# jarvOS Starter Kit

## Mandatory Flow: Kickoff Before Build

Before writing implementation code, complete project planning artifacts:

1. Fill `templates/PROJECT-KICKOFF-PACK.template.md`
2. Define OKRs (objective + measurable KRs)
3. Initialize `templates/OKR-TASK-BOARD.template.md`
4. Ensure each task maps to a KR and passes quality gates
5. Begin build only after kickoff gate is fully checked

This keeps execution outcome-driven, auditable, and portable.

## Runtime Onboarding Defaults (Core)

Runtime onboarding behavior is inherited from jarvOS core templates (`jarvos/templates/AGENTS-template.md` + `jarvos/templates/BOOTSTRAP-template.md`):
- activation-first onboarding finish (1-3 concrete activation tasks)
- brief-first setup (daily + weekly brief/review early)
- proactive next-work closeouts (1-3 concrete options, unless user explicitly ends)
- "search the last X days" interpreted as web-first lastXdays research, with local recall as support

## Project Governance Policy v1 (Default)

All project work should follow this baseline:
- link projects to Portfolio + Program by default
- if no fit exists, set `Program: Incubator` with reason + review date
- keep `Project Board.md` + `Project Brief.md` as a required pair
- maintain 3-6 milestones/decision gates per project
- hotfixes can start fast, but governance backfill is required in the same session

## Included Reusable Templates

- `templates/PROJECT-KICKOFF-PACK.template.md`
- `templates/OKR-TASK-BOARD.template.md`

## Gateway Watchdog Starter Pattern

The starter kit now includes an OpenClaw gateway watchdog pattern for the partial-failure case where the gateway process is still running, the TCP listener is still open, but real RPC calls are wedged.

Included files:
- `scripts/openclaw-health-check.sh`
- `scripts/openclaw-gateway-probe.sh`
- `scripts/openclaw-watchdog-status.sh`
- `scripts/lib/watchdog-signal-parser.sh`
- `tests/watchdog-signal-parser.test.sh`

What the pattern does:
- runs an external health check instead of relying on the main assistant session
- checks both TCP reachability and a real RPC call
- only triggers main-session cooldown on the narrow signal bundle: `main-session` + `lane-wait` + (`stale-session-lock` or `embedded-timeout`)
- archives the stuck main session before removing it from `sessions.json`
- provides one command for live probing and one for operator status snapshots

Quick checks:
- `bash tests/watchdog-signal-parser.test.sh`
- `bash scripts/openclaw-gateway-probe.sh`
- `bash scripts/openclaw-watchdog-status.sh`

Docs:
- `../jarvos/public-docs/operations/openclaw-watchdog-cooldown-pattern.md`
- `../jarvos/public-docs/operations/openclaw-watchdog-runbook.md`

Adopt it in another repo:
1. copy `scripts/`, `tests/watchdog-signal-parser.test.sh`, and the two public docs links into your ops docs
2. set the env overrides that differ in your environment: `JARVOS_WORKDIR`, `OPENCLAW_GATEWAY_LABEL`, `OPENCLAW_GATEWAY_PLIST`, and session-store paths
3. schedule `scripts/openclaw-health-check.sh` from an external runner such as `launchd` or cron instead of the main assistant session
4. verify with `bash tests/watchdog-signal-parser.test.sh`, `bash scripts/openclaw-gateway-probe.sh`, and `bash scripts/openclaw-watchdog-status.sh` before enabling automatic recovery
