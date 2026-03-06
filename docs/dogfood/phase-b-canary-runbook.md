# Phase B Canary Runbook

Use this checklist to dogfood a fresh jarvOS workspace without cutting over all at once.

## Goal

Validate that the public repo works as the base layer, while keeping personal files and secrets local.

## Preconditions

- Start from a fresh clone of the public repo
- Keep personal files as local overlays, not committed repo content
- Configure local paths and secrets only in local config files
- Enable low-risk automation first

## Recommended overlay set

Keep these local and gitignored in the canary workspace:

- `USER.md`
- `MEMORY.md`
- `ONTOLOGY.md`
- `TOOLS.md`
- `jarvos.config.json`
- any local persona files your runtime still depends on

## Canary checklist

1. Clone the public repo into a new workspace.
2. Copy the required local overlay files into that workspace.
3. Add the overlay files to local git ignore rules.
4. Copy the shipped templates into their runtime filenames.
5. Verify the assistant can boot and read the workspace without enabling automation.
6. Enable read-only or reporting behavior first.
7. Enable heartbeat and other low-risk scheduled tasks.
8. Wait 48 hours before enabling broader autonomous execution.

## Success criteria

- No context-overflow incidents for 48 hours
- No internal-only messages leak into user-facing channels
- Scheduled job visibility and approval behavior match expectations
- Local overlay files stay untracked throughout the canary

## Rollback triggers

Rollback immediately if you see repeated context overload, unexpected outbound messaging, or config drift that requires editing the public repo just to keep the canary running.

## Related troubleshooting

- `docs/troubleshooting/context-management-overload.md`
- `docs/troubleshooting/acp-wrapper-regression-workaround.md`
