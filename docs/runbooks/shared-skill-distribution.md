# Shared skill distribution runbook

Use the public catalog for reviewed portable skills. Add private skills through an explicit local overlay outside the checkout; never place private paths, bodies, receipts, or egress consent in the public manifest.

Before enabling a harness, run:

```sh
npm --prefix modules/jarvos-skills test
node modules/jarvos-runtime-kit/scripts/jarvos-runtime-kit.js check all
node modules/jarvos-skills/scripts/dogfood-skills.js --matrix --isolated
node modules/jarvos-skills/scripts/live-preflight-checklist.js --json
```

If a projection reports `unmanaged`, `local_modified`, `unsafe`, or `conflict`, preserve that directory and resolve the condition before attempting a protected repair. A persisted alias is intentional; do not rename it automatically just because a collision later disappears.

For a private overlay, authorize remote model verification separately for each harness. Without that authorization, the correct state is `verification_pending`, not a synthetic successful proof. Live dogfood must be run by the owner on the target machine and its receipt must be redacted before sharing.

## Operator commands

```sh
jarvos-skills init-config --json
jarvos-skills share --id NAME --path /absolute/or/home-relative/bundle --scope public|local --json
jarvos-skills refresh --json
jarvos-skills plan --json
jarvos-skills apply --json
jarvos-skills status --json
jarvos-skills repair --json
jarvos-skills inventory --json
jarvos-skills inventory-assess --json
jarvos-skills autonomous-repair --json
jarvos-skills-scheduled-repair --config ~/.jarvos/shared-skills/config.json
jarvos-skills enable --harness codex --json
jarvos-skills disable --harness hermes --json
jarvos-skills rename --id NAME --name EFFECTIVE --json
jarvos-skills scheduler --write --interval-minutes 60 --json
```

Scheduler artifacts are planned/written only. Enabling launchd or systemd units
is an owner action after review. The scheduler runs `autonomous-repair`, which
first completes a multi-root inventory generation and refuses to mutate if any
available root is incomplete, stale, or overflowed. It may assess and reconcile
only rule-proven candidates under the configured local trust policy; it cannot
register roots, broaden trust/privacy policy, approve ambiguity, overwrite a
local modification, authorize egress, or roll back a generation.

Events are merely debounced wake-ups, not proof that a skill is safe to share.
The full scan and mutation lease are authoritative. Healthy recurring runs are
quiet and write no durable state. A new actionable transition gets one redacted
notice; a recovery gets one redacted recovery notice.

Use `jarvos-skills-scheduled-repair` when a scheduler delivers stdout. Healthy
replays, safe holds, and completed automatic repairs emit exactly `NO_REPLY`;
safe holds remain available through durable local status. When Andrew must make
a decision, jarvOS sends a reviewed recovery message that says what happened,
what jarvOS preserved, what action is needed, what happens next, and an opaque
reference. It never exposes source names, paths, receipt details, or internal
reason codes. Pass `--announce-convergence` once through the configured delivery
route after activation, then remove that flag so subsequent healthy runs remain
quiet.

For an exact-path proof, bind each higher-precedence project or workspace root
as an absolute `scopeRoots` path and set `scopeRootsComplete: true` in the local
config. Relative adapter defaults are intentionally not proof of the project
where a harness is currently running.

## Doctor and live preflight

```sh
jarvos-skills doctor-shared --json
node modules/jarvos-skills/scripts/live-preflight-checklist.js --json
```

`doctor-shared` is read-only. The live-preflight checklist proves package gates
and isolated matrix dogfood, then leaves Claude interactive probe, private
Hermes overlay, scheduler enablement, and live harness gates as owner-pending.
It is permanently read-only and rejects `--allow-writes`; do the first live
convergence only from the installed, merged runtime. Keep local paths, bodies,
receipts, and egress consent out of issue, PR, and release evidence.
