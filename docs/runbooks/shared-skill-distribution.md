# Shared skill distribution runbook

Use the public catalog for reviewed portable skills. Add private skills through an explicit local overlay outside the checkout; never place private paths, bodies, receipts, or egress consent in the public manifest.

Before enabling a harness, run:

```sh
npm --prefix modules/jarvos-skills test
node modules/jarvos-runtime-kit/scripts/jarvos-runtime-kit.js check all
node modules/jarvos-skills/scripts/dogfood-skills.js --matrix --isolated
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
jarvos-skills enable --harness codex --json
jarvos-skills disable --harness hermes --json
jarvos-skills rename --id NAME --name EFFECTIVE --json
jarvos-skills scheduler --write --interval-minutes 60 --json
```

Scheduler artifacts are planned/written only. Enabling launchd or systemd units
is an owner action after review. Do not treat unit write success as live
activation.

