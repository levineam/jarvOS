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
quiet and write no durable state. A recovery gets one redacted recovery notice.

Use `jarvos-skills-scheduled-repair` when a scheduler delivers stdout. Healthy
replays, safe holds, and completed automatic repairs emit exactly `NO_REPLY`;
safe holds remain available through durable local status. A recovery failure
gets a reviewed message that says what happened, what jarvOS preserved, what
action is needed, what happens next, and an opaque reference, without source
names, paths, receipt details, or internal reason codes.

Rule-proven compatible skills are still admitted and projected automatically.
Every other unresolved skill decision (a skill that needs approval, a name
conflict, an ambiguous source, an unsupported capability, an accepted source
that disappeared, an unsafe source, a source that appears to hold private
information, or scripts in a folder trusted only for instructions) becomes a
named owner decision. Alone, it is sent as its own message: the skill, the
affected harnesses, the cause in plain English, what jarvOS preserved, how to
fix it, and the exact choices. Several at once share one digest, described
below. Unsafe,
private, and under-trusted skills can only be kept local or excluded; no
decision can share them. A source that disappears before it was ever accepted
stays quiet. Decisions are reconciled from the private assessed inventory, so they
carry real skill names; stored decisions keep only harness ids and one
preserved-state word, never paths, bodies, or diagnostics. Pending named
decisions take precedence over generic safety-hold status.

Each scheduler occurrence (by default the UTC hour of the run) claims exactly
one reminder for every unresolved decision, so nothing waits an extra hour. A
scheduler that can catch up or retry a missed run should pass its own
deterministic `--occurrence KEY` (up to 64 characters of letters, digits, `:`,
`.`, `_`, or `-`, starting with a letter or digit), so a late retry keeps the
same reminder identity. Prefer a name followed by the UTC hour, such as
`hour-2026-08-16T16` or `my-runner:2026-08-16T16`: jarvOS keeps only the latest
hour it reminded for each such name, so that hour and every earlier one can
never remind again, however much later it is replayed. A key that stamps the
same shape to the minute (`my-runner:2026-08-16T16:30`) names that same hour, so
a runner's within-hour retries still dedupe exactly. An hourly key more than an
hour in the future is refused. Other keys are remembered exactly, up to a fixed
bound, so a run key that carries no UTC hour eventually exhausts that bound;
name a series and a UTC hour instead.
If a reminder cannot be recorded (a stuck lock gate, a busy or unreadable
decision ledger, or a rejected occurrence), the run changes nothing, exits
non-zero, and sends a named recovery once per occurrence until it is fixed.
Reminders repeat hourly until the decision is
resolved or disappears. Silence never pauses them. Through the owner session,
`acknowledge-decision` pauses reminders without resolving, `defer-decision`
with a future `until` pauses them until that time (they then resume by
themselves), and `resume-decision` restores them. Reminders are independent of
the bounded initial and fallback delivery attempts, which remain the
acknowledgeable outbox for uncertain transports.

When several decisions are due at once, the occurrence still reminds every one
of them in the decision ledger, but sends one digest message instead of one
message per group. The digest (a `skill-owner-decision-batch` event with
`pendingCount`) names a stable preview of at most four decisions, the first in
pending order, each with its plain-English cause and exact options, and states
the total and how many are not shown. It tells the owner to “Ask jarvOS to list
your pending skill decisions.”; the owner session's shared-skills decision list
returns every pending decision by name with its choices. A decision left out of
the preview is not resolved, acknowledged, paused, or dropped: it stays pending,
is counted, and is reminded again next hour. `pendingCount` has no ceiling, so
a large backlog is always one bounded message. Every reply still names its
skill, one decision at a time, so a reply correlated only to the message
resolves nothing and no reply decides several skills at once.

The action-required envelope keeps its `messages` array; a digest occurrence has
exactly one entry, and the top-level fields mirror it. Chunked batches from
older producers (`chunkIndex`/`chunkCount`, one message per group of two to
four) still validate, render, and deliver unchanged.

## Desktop recommendation projection

`projectSkillSyncDesktop` is the public, read-only producer contract for a
Desktop consumer. It emits
`jarvos.skill-sync-desktop-recommendations/v1` with a numeric `version`, one
projection `generatedAt`, and current or invalidated freshness state. It does
not move policy, repair, recommendation, or apply authority into Desktop.

Every pending decision is bound to its opaque `decisionReference` and exact
`revision`. Without a durable recommendation its state is `analysis_required`
and its primary action is **Generate recommendation**. With a matching durable
recommendation its state is `recommendation_available` and its primary action
is **See recommendation**. A recommendation from an older revision is exposed
only as invalidated metadata; its rationale and apply operation are withheld.

A current recommendation contains the decision, plain-English rationale,
affected harnesses and expected result, material risk, uncertainty, every
remaining option with its tradeoff, and one `resolve_skill_decision` operation
bound to the decision reference, revision, and selected option. The host
adapter must pass that mapping through the existing owner-only resolution path,
which revalidates the current skill, option set, semantic identity, and
revision before mutation. The producer never treats the projection itself as
authority to apply.

Every item also exposes **Not now** as an `acknowledge_skill_decision`
operation with `resolves: false`; it pauses reminders and never resolves the
decision. Operation descriptors carry explicit availability derived from the
verified host adapter. The default is unavailable, so a consumer cannot turn a
schema label or opaque handle into authority. There is currently no durable
recommendation reader or `generate_skill_recommendation` host adapter; the
supported checkpoint is a read-only projection with Generate disabled. The
existing owner-only adapter may explicitly enable acknowledgement and
revision-revalidated resolution when a future trusted recommendation producer
supplies current durable state.

The default projection allowlists only public decision identity,
skill name, harness ids, bounded display-safe recommendation text, option
mappings, and freshness metadata. It contains no private paths, skill bodies,
raw diffs, raw receipts, or diagnostic payloads.

A retry of the same occurrence never claims a second reminder: reminder counts
do not move and the ledger is not written again. It re-renders the digest under
the same dedupe identity, so a sender that failed to deliver it can recover it
instead of waiting an hour. The replay counts only decisions that are still
pending and still remindable, so one resolved, acknowledged, or deferred in the
meantime drops out and is never revived, and a decision that first became
actionable after the occurrence began leads the next occurrence rather than
joining this one. Once a sender has accepted a digest for an occurrence, it
sends no further owner-decision message for that occurrence, even if the
preview, membership, or shape (a digest shrinking to a single decision)
changes; a digest is likewise not sent for an occurrence whose older chunked
decision messages were already accepted. Only confirmed provider acceptance
counts. Only the current occurrence of an hourly series replays; once a later
hour has been claimed, every earlier hour is closed for good. The next
occurrence sends one digest again. The separate v1 migration notice remains a
count-only summary that explains how to list the named decisions through the
owner session.

Pass `--announce-convergence` once through the configured delivery route after
activation, then remove that flag so subsequent healthy runs remain quiet.

## Active Assistant update proof

Treat projection, fresh-session discovery, existing-session refresh, and
delivery as four different boundaries. Matching bundle digests and receipts
prove projection; they do not prove that a model saw or followed the changed
instructions.

For OpenClaw-backed Active Assistant, first read the configured workspace for
the Active Assistant agent. For the default agent, start with:

```sh
openclaw config get agents.defaults.workspace
```

Use the exact returned path below; do not guess it from the current shell. A
named agent may override the default, so resolve that agent's configured
workspace instead. Then confirm that workspace uses a file-backed skill root
and that global skill watching is enabled:

```sh
cd /path/to/active-assistant-workspace
openclaw config get skills.load
openclaw skills list --json
```

The effective `skills.load.watch` value must be `true`, and the target skill's
list entry must be eligible and model-visible. An omitted `watch` key counts
only when the installed OpenClaw documentation declares its default to be
`true`; record that default with the proof. The skill's `source` must identify
the expected file-backed origin. Current file-backed labels are
`openclaw-workspace`, `openclaw-extra`, and `openclaw-managed`; verify the
installed CLI's reported source rather than inferring it from a directory name.
`openclaw-managed` is OpenClaw's watched, file-backed user skill root (normally
`~/.openclaw/skills`), not a pinned managed-library selection. Any other source
requires its own source contract and must not be treated as watched file-backed
state. Run one owner-authorized fresh-session behavior check through the configured primary
model, without forcing a different provider. Replace the placeholders with a
disposable fixture marker or a bounded behavior that uniquely exercises the
real update:

```sh
openclaw agent exec --cwd /path/to/active-assistant-workspace --json \
  'Invoke the <skill-name> skill. Return only <expected-new-behavior>.'
```

This model call can consume provider allowance even though it sends no user
message. The headless `agent exec` surface proves fresh-session discovery only
and is non-delivering; confirm with `openclaw agent exec --help` that the
installed command has no delivery option, and never substitute `openclaw agent
--deliver`. Record the served provider/model, the skill read or invocation
evidence, and the bounded response. A forced model whose auth profile is
unavailable is a bad proof command, not evidence that Skill Sync or Active
Assistant discovery failed.

For the separate existing-session boundary, the file watcher makes a changed
`SKILL.md` available on the next turn after its event. Prove that boundary on
the next real owner update or with a disposable skill root. First run `openclaw
agent --help` and confirm that `--session-id`, `--message`, `--json`, and the
named-agent selector (when needed) are supported and that `--deliver` defaults
to false. Choose a new disposable `<existing-session-id>`. If the Active
Assistant is a named agent, add the same `--agent <id>` argument to both
commands below. Create the session and observe version 1 without `--deliver`:

```sh
openclaw agent --session-id <existing-session-id> --json \
  --message 'Invoke the <skill-name> skill. Return only <expected-version-1-behavior>.'
```

Change and reconcile the canonical source. Then confirm the watcher event was
processed, or wait longer than the installed watcher's documented debounce,
before reusing the exact same session id for version 2. Omit `--deliver` again:

```sh
openclaw agent --session-id <existing-session-id> --json \
  --message 'Invoke the <skill-name> skill. Return only <expected-version-2-behavior>.'
```

Record the unchanged session id, both bounded responses, and the watch event or
debounce evidence. Do not edit a production skill merely to manufacture this
receipt. If watching is disabled, or OpenClaw logs that native file-watch
capacity was exhausted and stopped its watchers, repair that condition and
start a new session. Managed-library selections do not follow this file-backed
rule and require an explicit `openclaw skills library refresh` for the selected
session.

Telegram or any other external send remains a separate delivery proof and
requires its own authority and transport receipt.

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
and isolated matrix dogfood, then leaves the Claude interactive probe,
delivery-disabled Active Assistant fresh-discovery proof, separate
existing-session refresh proof, private Hermes overlay, scheduler enablement,
and live harness gates as owner-controlled follow-up. It is permanently
read-only and rejects `--allow-writes`; do the first live convergence only from
the installed, merged runtime. Keep local paths, bodies, receipts, and egress
consent out of issue, PR, and release evidence.
