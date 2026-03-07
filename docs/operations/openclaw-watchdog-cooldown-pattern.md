# OpenClaw Watchdog + Main-Session Cooldown Pattern

Updated: 2026-03-07

## Purpose

This starter pattern covers a specific partial-failure mode in OpenClaw: the gateway process is still running and the TCP listener is still open, but real RPC calls are timing out or wedged.

The pattern is intentionally conservative:
- run the watchdog outside the main assistant session
- use a live RPC probe, not just a port check
- attempt normal restart paths first
- only rotate the main session on a narrow signal bundle
- archive session state before changing it

## Starter-kit files

- `starter-kit/scripts/openclaw-health-check.sh`
- `starter-kit/scripts/openclaw-gateway-probe.sh`
- `starter-kit/scripts/openclaw-watchdog-status.sh`
- `starter-kit/scripts/lib/watchdog-signal-parser.sh`
- `starter-kit/tests/watchdog-signal-parser.test.sh`

## Health-check behavior

Each watchdog run does three things:

1. checks TCP reachability for the gateway listener
2. runs `openclaw gateway call status --json --timeout ...`
3. only marks the gateway healthy when both pass

If TCP is reachable but RPC still fails, the watchdog treats that as degraded and starts recovery.

## Recovery sequence

The watchdog escalates in this order:

1. `openclaw gateway restart`
2. `launchctl kickstart -k` on the gateway service
3. targeted main-session cooldown if the signal bundle matches

That keeps the more invasive recovery path behind two cheaper checks.

## Narrow cooldown trigger

Main-session cooldown is only eligible when recent gateway error output contains:

- `main-session`
- `lane-wait`
- and at least one of:
  - `stale-session-lock`
  - `embedded-timeout`

This is the same narrow pattern proven in the source implementation. It avoids rotating the main session for generic slowness or unrelated gateway failures.

## Archive-first safety behavior

When cooldown is triggered, the script:

1. reads the current `agent:main:main` session ID from `sessions.json`
2. stops the gateway service
3. copies `sessions.json` to `sessions.json.before` inside a timestamped archive directory
4. removes only the `agent:main:main` entry from the live store
5. moves matching transcript files into the archive directory
6. records the action in a cooldown ledger
7. restarts the gateway and re-runs the RPC probe

This makes rollback possible and prevents destructive cleanup.

## Operator helper pattern

The starter kit includes two helper commands:

- `starter-kit/scripts/openclaw-gateway-probe.sh` for the same live probe path the watchdog relies on
- `starter-kit/scripts/openclaw-watchdog-status.sh` for launchd state, health files, latest log, cooldown record, and recent log tail

Use the helpers first before touching launchd or session files manually.

## Adopt in a new repo

1. copy the starter-kit scripts and parser test together so the trigger logic stays testable
2. wire environment-specific values through env vars instead of editing trigger logic inline
3. schedule the health check from an external runner, not from the main assistant lane
4. run the parser test, live probe helper, and status helper before turning on automated recovery
