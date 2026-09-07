# Local OpenClaw Profile

The local OpenClaw profile is the supported one-click path for running jarvOS on
top of a local OpenClaw runtime. It treats OpenClaw as an adapter, not as the
portable foundation of jarvOS.

## Initialize

```bash
jarvos init --profile local-openclaw --workspace /path/to/workspace
```

The init command creates missing portable workspace files, merges missing
jarvOS config fields, records the installed skill manifest, and writes
OpenClaw workspace state. If `jarvos.config.json` or jarvOS workspace state
already exists and needs to change, the command writes a timestamped backup
before replacing it.

The command does not create or overwrite `openclaw.json`. Existing OpenClaw
runtime config is detected and preserved.

This guarantee applies to `jarvos init` and the ordinary local profile. The
separate explicitly activated managed runtime setup in
`runtimes/openclaw/setup.sh` may perform a narrow OpenClaw plugin registration:
it backs up before writing, preserves unrelated configuration, verifies the
staged jarvOS adapter through OpenClaw's read-only inspection surface, and
restores the exact prior bytes, mode, and presence if its own new registration
fails. It never copies the staged adapter into OpenClaw's managed npm root.

For isolated tests, pass an explicit OpenClaw state directory:

```bash
jarvos init --profile local-openclaw \
  --workspace /tmp/jarvos-workspace \
  --openclaw-dir /tmp/openclaw-state
```

## GBrain Provider

Portable jarvOS treats GBrain as optional. Andrew's private profile requires
one shared local GBrain for Codex, Hermes, and OpenClaw. GBrain owns structured
recall and provider-owned skills; it does not own Paperclip state,
workflow-execution, release placement, raw Vault notes, journal backlinks, or
jarvOS governance.

The supported private topology is local Postgres plus one provider-native stdio
registration per harness. Each registration runs the jarvOS provenance
launcher with the same owner-only runtime descriptor. Database credentials
remain in GBrain's owner-only configuration, the service stays loopback-only,
and `GBRAIN_SWEEP=0` leaves maintenance to the scheduler-owned delta path.
Remote `gbrain connect` is not the default for this local private topology.

Skillify is not installed into Codex or the jarvOS shared-skill bundle. Enable
GBrain's skill publication consent in the private profile, then prove discovery
through GBrain's `list_skills` and `get_skill` tools so resolver provenance and
quality gates remain intact.

## Doctor

```bash
jarvos doctor --profile local-openclaw \
  --workspace /path/to/workspace \
  --obsidian-vault /path/to/obsidian-vault
```

The doctor reports three kinds of dependency state:

- `ok`: required or optional dependency is present.
- `fail`: a required dependency, such as the `openclaw` command, is missing.
- `skipped`: an optional dependency or init artifact is absent but not required
  for the portable jarvOS workspace contract.
- `warn`: a dependency is usable, but the install has a drift risk that should
  be fixed.

This means a fresh workspace can show a partial result before optional
continuity tooling such as `lossless-claw` is installed, while still failing
clearly when the local OpenClaw runtime itself is missing.

For `local-openclaw`, doctor also performs a bounded plugin-persistence check.
It reads the supported OpenClaw version, registry, and inspection surfaces
without editing configuration. Missing user-managed records, paths, manifests,
or unavailable plugins are warnings. A missing enabled jarvOS staged adapter is
a failure because jarvOS owns that adapter. Unsupported or changing evidence
is reported as skipped or warning rather than treated as healthy.

Recovery is deliberate: inspect the affected plugin and confirm scope, use the
official OpenClaw install/enable command only for that confirmed plugin, and
rerun doctor. Do not edit generated registry state, run broad `doctor --fix`
from cleanup, or ask jarvOS to reinstall arbitrary user plugins.

Doctor also reports:

- `provider.gbrain`: installed GBrain version and stale-version warnings against
  the profile's minimum provider version.
- `provider.gbrain.status`: `gbrain status --fast --json` summary when available.
- `provider.gbrain.advisor`: advisor availability and worst-severity summary.
- the `gbrain-continuity` health module: per-target registration, reachability,
  runtime/brain/store identity, capability, freshness, maintenance, backup,
  machine proof, and native live-turn proof for Codex, Hermes, and OpenClaw.

An installed binary is never treated as continuity proof. All three targets
must match the same runtime, logical-brain, store, and fixture digests; Codex
must additionally prove Skillify discovery. Raw URLs, paths, credentials,
queries, and recalled content stay out of the public doctor snapshot.

The snapshot producer accepts only an owner-only, exact-schema input and writes
the continuity module atomically with a strictly increasing generation:

```bash
node scripts/jarvos-gbrain-continuity-snapshot.js \
  --workspace /absolute/jarvos-workspace \
  --descriptor /absolute/owner-only/gbrain-runtime.json \
  --input /absolute/owner-only/continuity-producer-input.json
```

Missing GBrain is a warning, not a profile failure. Stale GBrain remains visible
until upgraded because provider drift can silently weaken memory and skillpack
behavior.

When an Obsidian vault is available, doctor also checks the journal single-writer
contract. Obsidian Sync is fine: it should sync the markdown vault. Automated
Obsidian daily-note creation should be disabled or pointed somewhere else so
jarvOS remains the sole automated writer for generated `Journal/YYYY-MM-DD.md`
sections. Doctor warns on the Journals plugin, core Daily Notes, Periodic Notes,
and Templater startup scripts that can create daily notes, and it warns when
`jarvos.config.json` points at a stale vault or journal path.
