# @jarvos/skills

`@jarvos/skills` is the public jarvOS operating-system skill bundle. It packages
the reusable agent workflows that make a fresh OpenClaw-style install behave
like a disciplined personal AI operating system without importing Andrew-specific
workspace rules.

## Included by default

| Skill | Purpose |
|---|---|
| `workflow-execution` | Plan, track, package, execute, and verify non-trivial work. |
| `rule-creation` | Wire new behavioral rules into the right governance surface with enforcement assessment. |
| `context-management` | Keep always-loaded context compact, coherent, and routed to the right durable store. |
| `cron-hygiene` | Validate, audit, and maintain scheduled automation safely. |

These are markdown skills. They are portable by design: copy the skill folders
into the runtime's skill directory, or use the installer helper below.

## Install

```bash
cd modules/jarvos-skills
node scripts/install-skills.js --dest /path/to/openclaw-workspace/skills
```

To validate the shipped bundle without installing:

```bash
node scripts/install-skills.js --check
```

To install a subset:

```bash
node scripts/install-skills.js --dest /path/to/skills --skill workflow-execution --skill cron-hygiene
```

Use `--force` only when intentionally replacing an existing local copy.

## Manifest

`manifest.json` is the source of truth for the default bundle. Runtimes and setup
scripts should read it instead of hardcoding the skill list.

## QMD decision

QMD is not bundled as a default skill. jarvOS treats QMD as markdown-search
software and an optional retrieval adapter. Use it when your runtime needs broad
vault lookup or exact note retrieval; do not make it part of the core operating
workflow layer. See [`docs/qmd-adapter.md`](docs/qmd-adapter.md).

## Public boundary

The skills in this module describe generic behavior and workflow discipline. They
avoid private paths, personal project names, live company governance, and local
tokens. A user should be able to fork these files, adapt the tracker/runtime
names, and keep the same operating pattern.
