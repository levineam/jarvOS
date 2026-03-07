# OpenClaw Watchdog Runbook

Updated: 2026-03-07

## Status

Use the operator helper for a one-command snapshot:

```bash
bash starter-kit/scripts/openclaw-watchdog-status.sh
```

It reports:
- watchdog launchd summary
- gateway launchd summary
- current health state/detail files
- latest watchdog run log
- last main-session cooldown record
- tail of the most recent run log

## Probe

Run the live probe helper from the same machine as the gateway:

```bash
bash starter-kit/scripts/openclaw-gateway-probe.sh
```

Expected outcome when healthy:
- `openclaw health --json ...` succeeds
- `openclaw gateway call status --json ...` succeeds

## Recovery

Normal recovery order:

1. let the watchdog try `openclaw gateway restart`
2. let the watchdog try `launchctl kickstart -k`
3. only then allow main-session cooldown if the narrow signal bundle matches

If you intervene manually, use the same order. Do not jump straight to deleting or editing session state.

## Rollback

If a cooled session must be restored:

1. stop the gateway service
2. find the latest directory under `archived-main/`
3. copy `sessions.json.before` back to `sessions.json`
4. move the archived `<sessionId>*` transcript files back into the live sessions directory
5. restart the gateway
6. re-run the live probe helper

## Safety Constraints

- cooldown must stay scoped to `agent:main:main`
- archive before modifying the session store
- keep a cooldown ledger so the same session is not rotated repeatedly
- prefer helper scripts over ad hoc shell sequences
- treat the cooldown path as a fallback, not the default recovery action

## Adoption handoff

For a fresh install, hand over exactly these three verification commands with the copied assets:
- `bash tests/watchdog-signal-parser.test.sh`
- `bash scripts/openclaw-gateway-probe.sh`
- `bash scripts/openclaw-watchdog-status.sh`

If those pass, the repo is ready for scheduler wiring.

## Limitations

- this pattern recovers from the known wedge faster; it does not explain the upstream root cause
- the parser uses known gateway log phrases, so new upstream error wording may require updates
- launchd-specific recovery assumes macOS-style service management
- the helper scripts are environment-driven, but they still expect an OpenClaw installation and session layout
