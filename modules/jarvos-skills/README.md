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

These are markdown skills. They are portable by design: project the canonical
sources into the runtime's skill directory with the installer helper below. The
projection record stores source, base, and observed target digests, so a local
edit is reported and preserved rather than overwritten.

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

For managed runtime projections, inspect first and apply only the exact
generation you inspected:

```bash
node scripts/install-skills.js projection-plan --harness hermes --dest ~/.hermes/skills --json
node scripts/install-skills.js project --harness hermes --dest ~/.hermes/skills --apply --json
```

`project` creates missing targets and updates only clean managed targets. It
preserves unknown, locally modified, incompatible, and conflicting targets.
Projection state is stored under `.jarvos-projections/` in the chosen skills
root; it contains only public source/revision/digest metadata.

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

`manifest.json` is the source of truth for the default bundle. Each skill has
reviewed source revision, SHA-256 digest, license/provenance, supported-harness,
and target-rendering metadata. Runtimes and setup scripts should use the
projection commands instead of hardcoding copies or replacing local files.

## QMD decision

QMD is not bundled as a default skill. jarvOS treats QMD as markdown-search
software and an optional retrieval adapter. Use it when your runtime needs broad
vault lookup or exact note retrieval; do not make it part of the core operating
workflow layer. See [`docs/qmd-adapter.md`](docs/qmd-adapter.md).

For how QMD fits beside Obsidian-compatible Markdown, GBrain, memory-wiki,
generated LLM-wiki, agentmemory, Engraph, and optional Obsidian tooling, see
[the public secondbrain external integration inventory](https://github.com/levineam/jarvOS/blob/main/docs/architecture/secondbrain-external-integrations.md).

## Public boundary

The skills and packs in this module describe generic behavior, workflow
discipline, and default setup profiles. They avoid private paths, personal
project names, live company governance, and local tokens. A user should be able
to fork these files, adapt the tracker/runtime names, and keep the same operating
pattern.
