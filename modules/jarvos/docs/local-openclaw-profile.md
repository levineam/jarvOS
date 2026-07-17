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

For isolated tests, pass an explicit OpenClaw state directory:

```bash
jarvos init --profile local-openclaw \
  --workspace /tmp/jarvos-workspace \
  --openclaw-dir /tmp/openclaw-state
```

## GBrain Provider

The profile can use GBrain 0.42.52.0+ as an optional brain-native provider for
memory lookup, advisor/status, SkillOpt, and GBrain skillpack reference. GBrain is
not the jarvOS foundation and does not own Paperclip state, workflow-execution,
release placement, note creation, journal backlinks, or local governance.

Useful setup checks:

```bash
gbrain --version
gbrain status --fast --json
gbrain advisor --json
gbrain connect <https://brain.example.com/mcp> --agent codex --install --yes
gbrain connect <https://brain.example.com/mcp> --agent claude-code --install --yes
```

OpenClaw and Hermes should expose equivalent connection state through their
adapter config. `jarvos doctor` reports unknown runtime connection state as
`skipped` until the adapter can prove it.

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

Doctor also reports:

- `provider.gbrain`: installed GBrain version and stale-version warnings against
  the profile's minimum provider version.
- `provider.gbrain.status`: `gbrain status --fast --json` summary when available.
- `provider.gbrain.advisor`: advisor availability and worst-severity summary.
- `provider.gbrain.runtime.<tool>`: per-runtime connection state for Codex,
  Claude Code, OpenClaw, and Hermes when detectable.

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
