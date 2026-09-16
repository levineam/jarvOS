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
