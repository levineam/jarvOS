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

For a machine-wide jarvOS install, set
`JARVOS_SKILL_PROJECTION_EVENT_ROOT` or pass `--event-root` to write one
owner-only `jarvos.skill-install.v1` receipt after the selected files have
been verified. The receipt binds the installed release tuple, target root,
target digests, timestamp, nonce, and event digest; it contains no skill text
or secrets. The private control plane consumes each event once and treats the
daily reconciliation as its safety fallback. To request immediate
reconciliation, also set `JARVOS_SKILL_PROJECTION_TRIGGER` or pass
`--projection-trigger` with the absolute, owner-only path to the private
`jarvos-skill-projection.js` entrypoint. The trigger is best-effort: if it is
missing or fails, the verified event remains pending for the daily safety run.
Leaving the event root unset keeps project-local installs standalone.

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

The neutral `explore-unknowns` skill is a harmless fixture for verifying a
runtime adapter. Its projection metadata covers Claude Code, Codex, OpenClaw,
and Hermes. A private jarvOS control-plane manager may use the public
`planSkillProjection` and `applySkillProjection` functions only after verifying
the reviewed release tuple and the adapter's supported version.

## Managed Compound Engineering provider

The bundle declares Compound Engineering as a managed external provider for
the coding workflow. Its manifest is pinned to one reviewed upstream commit and
content digest; it is not followed from a moving branch and is not treated as
a JavaScript dependency. Provider reconciliation is a separate profile-scoped
operation from coding work-run execution.

Reconciliation has an inspect-then-apply boundary. It stages only an
allowlisted, digest-checked, non-executable regular-file fixture, then patches
only the jarvOS-owned provider entry in a harness profile. Unknown, legacy,
conflicting, or locally modified entries are reported and preserved. Candidate
upstream versions are recorded as one review item and never change the active
provider until a new jarvOS-approved manifest is shipped. Disable and rollback
remove only exact jarvOS-owned state.

The bundled `workflow-execution` skill maps ordinary `plan`, `work`, and
`complete` requests to jarvOS-coding's managed workflow when the active harness
has a healthy approved provider. Users do not need to learn CE command names.
`compound` is the optional post-verification learning tail: the eligibility gate
selects one reusable lesson, screens it for private content, and records its
outcome separately from coding completion. Routine work is `not-eligible`, and
provider failure or absence is `unavailable`/`failed` without reopening or
downgrading a verified run.

Codex is the first conformance-backed activation target. The shipped pin is CE
3.21.4 with an immutable revision and content digest, and the checked-in
disposable-profile receipt proves bounded invocation, strict receipts, denied
capabilities, restart behavior, and rollback. Doctor reports the active health
state and the native jarvOS workflow continues in the same run/worktree when CE
is absent or unavailable. Other harnesses remain explicitly
unsupported until they provide equivalent discovery, configuration-preservation,
invocation, rollback, and fallback evidence. Approved updates may be discovered
and staged automatically; only a reviewed manifest change can activate them.

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

## Machine-wide skill parity

jarvOS can make every eligible user-owned skill available to every compatible
supported harness: Codex, Claude Code, OpenClaw, and Hermes. This is a local,
machine-wide service—not a feature of whichever repository or chat is open.

The flow is ordered: `inventory` scans only registered absolute roots;
`inventory-assess` admits only rule-proven safe, portable candidates into an
owner-only immutable source store; `apply` reconciles that accepted generation
through the receipt-owning projector; and `autonomous-repair` coalesces events
and provides the periodic full-scan backstop. An incomplete scan cannot admit,
update, alias, or retire anything. A healthy replay writes and notifies nothing.

Public portable-skill selection remains explicit in
`schemas/catalog.schema.json` and `schemas/local-overlay.schema.json`.
Private overlay bodies, observed paths, snapshots, receipts, and delivery state
stay local. CLI, doctor, scheduler, and agent status use redacted logical IDs,
digests, states, and allowlisted reason codes only.


## Shared skill operator CLI

Public catalog operations are available on `jarvos-skills`:

```sh
jarvos-skills init-config --config ~/.jarvos/shared-skills/config.json --json
jarvos-skills share --id my-skill --path ./skills/my-skill --scope public --json
jarvos-skills plan --config ~/.jarvos/shared-skills/config.json --json
jarvos-skills apply --config ~/.jarvos/shared-skills/config.json --json
jarvos-skills status --config ~/.jarvos/shared-skills/config.json --json
jarvos-skills repair --config ~/.jarvos/shared-skills/config.json --json
jarvos-skills enable --harness codex --json
jarvos-skills disable --harness claude --json
jarvos-skills rename --id my-skill --name jarvos-my-skill --json
jarvos-skills scheduler --write --interval-minutes 60 --json
jarvos-skills doctor-shared --json
jarvos-skills inventory --json
jarvos-skills inventory-assess --json
jarvos-skills autonomous-repair --json
jarvos-skills-scheduled-repair --config ~/.jarvos/shared-skills/config.json
node scripts/live-preflight-checklist.js --json
```

`share --scope local` admits private bundles through an owner-controlled overlay
outside the package. Scheduler unit files are written disabled by default and
never auto-enable live harness gates. Claude interactive proof remains
`verification_pending` until the owner authorizes a remote model probe.

`autonomous-repair` is the scheduler command. It stays inert until inventory is
enabled in owner-local configuration and never enables the scheduler itself.
`jarvos-skills-scheduled-repair` wraps that command for delivery-aware schedulers:
healthy repeats print `NO_REPLY`, while new attention, repair, or failure prints
one redacted count-only message. `--announce-convergence` is a one-run activation
option, not a recurring schedule flag.
The public preflight is permanently read-only; first live convergence happens
only through the installed, merged runtime. See the
[architecture](../../docs/architecture/shared-skill-distribution.md) and
[runbook](../../docs/runbooks/shared-skill-distribution.md).


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
