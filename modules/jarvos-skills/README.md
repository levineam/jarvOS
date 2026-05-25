# @jarvos/skills

`@jarvos/skills` is the public jarvOS operating-system skill and experience-pack
layer. It packages the reusable agent workflows that make a fresh compatible
agent runtime behave like a disciplined personal AI operating system without
importing Andrew-specific workspace rules, plus manifest-driven packs that
describe richer default experiences.

## Included by default

| Skill | Purpose |
|---|---|
| `workflow-execution` | Plan, track, package, execute, and verify non-trivial work. |
| `rule-creation` | Wire new behavioral rules into the right governance surface with enforcement assessment. |
| `context-management` | Keep always-loaded context compact, coherent, and routed to the right durable store. |
| `cron-hygiene` | Validate, audit, and maintain scheduled automation safely. |

These are markdown skills. They are portable by design: copy the skill folders
into the runtime's skill directory, or use the installer helper below.

## Default Experience Pack

`obsidian-default` is the default jarvOS Obsidian experience pack. It references
`kepano/obsidian-skills` at commit `553ef99` and includes:

- `obsidian-markdown`
- `obsidian-cli`
- `defuddle`
- `json-canvas`
- `obsidian-bases`

Obsidian is the default front door because it makes Markdown notes, journals,
links, canvases, and review views feel good to use. It is not the foundation:
jarvOS remains Markdown-first, and `@jarvos/secondbrain` remains the owner of
note and journal contracts.

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

Run the pack doctor to inspect optional tool availability:

```bash
node scripts/install-skills.js doctor
node scripts/install-skills.js doctor --json
```

The doctor checks for optional commands such as `obsidian` and `defuddle`.
Missing commands do not disable jarvOS; they only disable CLI-backed parts of
the experience until installed.

## Installer Flow

1. Install the pack skills into the assistant skill directory for the runtime.
2. Configure `jarvos-secondbrain` paths with `JARVOS_NOTES_DIR` and
   `JARVOS_JOURNAL_DIR`, or with `paths.notes` and `paths.journal` in
   `jarvos.config.json`.
3. Run the doctor and install optional tools it reports:
   - `obsidian` enables live Obsidian app operations.
   - `defuddle` enables web-page-to-Markdown extraction.
4. Keep Paperclip as the live task authority. Obsidian Bases and Canvas are
   reading, review, and artifact surfaces only.

## Manifest

`manifest.json` is the source of truth for the default bundle. Runtimes and setup
scripts should read it instead of hardcoding the skill list.

## QMD decision

QMD is not bundled as a default skill. jarvOS treats QMD as markdown-search
software and an optional retrieval adapter. Use it when your runtime needs broad
vault lookup or exact note retrieval; do not make it part of the core operating
workflow layer. See [`docs/qmd-adapter.md`](docs/qmd-adapter.md).

## Public boundary

The skills and packs in this module describe generic behavior, workflow
discipline, and default setup profiles. They avoid private paths, personal
project names, live company governance, and local tokens. A user should be able
to fork these files, adapt the tracker/runtime names, and keep the same operating
pattern.
