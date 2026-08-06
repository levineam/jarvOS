# jarvos-secondbrain-projects

The Projects record: one markdown page per project, in your vault.

Every project page holds three things:

- **Goal** — what outcome this produces, and why it matters
- **High-level plan** — the main steps, in rough order
- **Definition of Done** — how you know it is finished

That is deliberately all. It is the minimum needed to tell whether a project is
on track, and little enough that keeping it current is not a chore.

## Why markdown files

Projects are plain files in `<vault>/Projects/`. No database, no sync, no
export step. They stay readable with none of this tooling installed, they diff,
and the whole directory can be handed to an assistant as context — which is the
point. An assistant given your journal, your ideas, and your projects knows what
you are actually trying to do.

The daily journal lists the ongoing ones, so the vault stays the one surface
where you and your assistants get aligned.

The canonical Projects context contract is the assistant-facing read model:
`jarvOS` is a durable Project and `v1.0.0 release` is a child Outcome. Legacy
pages can be inspected with the dry-run migration API without changing source
files. Applying a migration requires an explicit mapping, field-disposition
table, source digest, and approval; the migration ledger makes reruns,
conflicts, and rollback visible.

The touched-only journal projection is separate from the legacy all-ongoing
list. It renders only canonical parent Projects with accepted activity on the
requested local date. A fresh empty activity result removes a stale generated
Projects section; partial or unavailable activity preserves it. Reading a
Projects context packet is not activity.

## Usage

```bash
jarvos-projects new "Ship the release"   # create a page from the template
jarvos-projects list                     # every project and its status
jarvos-projects check                    # ongoing projects missing a section
jarvos-projects index                    # regenerate index.md
```

`check` exits non-zero when an ongoing project is missing a Goal, plan, or
Definition of Done, so it can gate a scheduled routine. A project with no
Definition of Done cannot be judged on track or off track — catching that is
most of the value here.

## Status

| status | in the journal? | meaning |
| --- | --- | --- |
| `active` | yes | being worked on |
| `paused` | yes | deliberately set down, still yours |
| `done` | no | finished |
| `abandoned` | no | dropped on purpose |

`paused` stays visible on purpose. Hiding paused work is how projects get
silently dropped.

## Where things live

- Projects directory: `JARVOS_PROJECTS_DIR`, else `<vault>/Projects`, where
  `<vault>` comes from `JARVOS_VAULT_DIR` or `jarvos.config.json` `paths.vault`.
- Contract: `config/projects-module.json` — directory, required sections,
  statuses, and how the journal section renders.

`index.md` is generated from the project pages. It is a view, not a source of
truth; edits to it are overwritten.

## Programmatic context APIs

Additional provider-neutral APIs are exported as `./migrate` and
`./journal-projection`. Their mutation callbacks are injected and receive an
expected-content revision plus a projection manifest; they do not write the
vault directly.

Version 2 requires Obsidian-owned mutation callbacks for `createProject()` and
`writeIndex()`. This is an intentional safety boundary: library callers must
compose callbacks from the canonical jarvOS vault mutation service; the bundled
CLI no longer falls back to direct Markdown filesystem writes.

## Not in scope

This package does not talk to any issue tracker. Comparing projects against
tracker state — whether a tracked project has a definition of done, whether the
goals still match — is a separate concern built on top of this one.

## Stewardship project-context capability

`src/project-context.js` also defines the portable `jarvos.project-context/v1`
contract used to authorize bounded stewardship context projection into Projects.
It is a context-only port, not a project or task ledger: a caller-authorized,
unsigned capability exposes one private/internal destination selector, permitted
candidate visibility (`private`, `internal`, or `mixed`), revision, and expiry
only. Each projected activity receives its opaque correlation key at the
projection boundary.

The caller supplies the exact input identity (`findingId`, `executionReference`,
`releaseReference`, and `visibility`) only at projection time. The package hashes
it into a correlation key and never serializes those source values into the
capability. A caller that is not authorized receives only `{ status: 'denied' }`,
so absence and denial do not enumerate destinations. The owner-only host policy
binds the runtime admission boundary; this package contains no private key,
local path, source content, task status, activation state, or signing path.
External/public destinations are publication and are rejected.
