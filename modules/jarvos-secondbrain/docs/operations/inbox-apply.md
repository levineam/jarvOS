# Apply synced phone captures

Run on a host that has the vault and the existing capture service configured:

```sh
jarvos inbox apply [--vault <abs path>] [--inbox <abs path>] [--limit N] [--json]
```

`--vault` selects an absolute vault path; otherwise the shared `resolveConfig`
resolver selects the configured vault, just as for capture. The default limit
is 50 complete requests, oldest modification time first. Incomplete requests
and terminal receipts do not consume the limit. A host timer or desktop app
decides when and where to run it; this command installs no timer or host policy.

`--inbox` selects an absolute inbox root, such as a folder synced by your phone's
cloud drive in the background. Without it, the root is `<vault>/phanos`.
For example: `jarvos inbox apply --vault /data/vault --inbox /data/phone-captures`.
Requests are read from `<root>/inbox/<device>/<opId>.md` and receipts go to
`<root>/receipts/<device>/<opId>.md`. Requests are never changed. Captures still
save into the vault through `simpleCapture`, with source `phanos-mobile` and the
configured vault mutation service. A missing capture acknowledgement is not
reported as saved.

Root containment uses resolved real paths. Receipts inside the vault use the
configured mutation service; receipts outside it are operational files written
directly using an exclusive hidden temporary file in the same folder, then
rename. Missing receipt folders are created one segment at a time with `lstat`
checks. The inbox root cannot be the vault root, a filesystem root, or the jarvOS
state directory (including its descendants). An external root's receipt directory
must not overlap the vault.

## Request format

The phone writes a hidden temporary file, then renames it to `<opId>.md`:

```markdown
---
phanos_request: capture/v1
op_id: 0f012026-caf1-4e59-99cd-5db5d4e5097f
device: phone-47ba92
kind: journal
words: user
asked: explicit
model: test-model
created: 2030-02-03T07:00:00-05:00
date: 2030-02-03
---
An invented first line.
An invented second line.

<!-- phanos:end -->
```

LF and CRLF are accepted. The final non-empty line must be exactly
`<!-- phanos:end -->`; a request without it is incomplete and gets no receipt.
Trailing blank lines after the marker and one separator blank line before it
are removed; the remaining text is passed verbatim to the capture layer.
Hidden files (including `.name.icloud` placeholders and temporary files) and
non-`.md` files are ignored. Requests are read fully up to the 256 KB validation
limit. A timeout, I/O error, or currently unreadable placeholder leaves a request
incomplete, with no receipt, to retry next run. Files over 256 KB are invalid.

The frontmatter is closed: only the keys above plus `title` are accepted;
duplicate keys are invalid. `op_id` and `device` must match their filename stem
and folder respectively, and match `^[A-Za-z0-9][A-Za-z0-9._-]{7,79}$`.
`kind` is `idea`, `journal`, or `note`; `words` must be `user` and `asked`
must be `explicit`. These declarations do not manufacture verified human
provenance. `model` is optional. `date` is an optional valid `YYYY-MM-DD`;
when absent, the date before `T` in `created` is used without timezone conversion.
If both are absent, the capture reservation chooses the day once and reuses it
on retries.

Only notes may supply `title`, encoded as a JSON double-quoted string, for
example `title: "A test note"`. It must be nonblank, at most 200 characters,
one line, without leading `.` or `-`, slashes, backslashes, or control
characters. Existing simple-capture text validation also applies.

## Receipt format and retries

Receipts use LF. Inside the vault, new receipts use the service's create operation; an existing
`not_confirmed` receipt uses an exact-content guarded replacement. Each write
has a stable mutation intent derived from its path, status, expected prior-content
hash, and body message, excluding the `applied` timestamp. Pending writes resume
the same ledger operation and original payload; earlier pending receipt operations
settle first, and acknowledged writes stay satisfied. Outside the vault, a
`not_confirmed` replacement compares the current receipt bytes with those read
before capture immediately before rename; a concurrent edit produces a receipt
conflict and is preserved. This compare-then-rename is not a distributed
compare-and-swap against cloud writers.

```markdown
---
phanos_receipt: capture/v1
op_id: 0f012026-caf1-4e59-99cd-5db5d4e5097f
status: saved
kind: journal
applied: 2030-02-03T07:00:00-05:00
---
Saved to Journal for 2030-02-03.
```

Status comes from structured capture outcomes. A note or journal artifact with
`saved_locally_sync_pending` or `deferred` makes it `not_confirmed`, including
a saved note with a deferred journal link. Otherwise it is `saved` for an ok
capture, `not_saved` for other not-ok results (including failed links), or
`invalid` for validation errors and operation-ID content conflicts. The body is the capture
message or broken rule, flattened to one line. Invalid input may omit `kind`
when no valid request could be parsed.

An existing receipt is skipped unless its status is `not_confirmed`; that
status is retried with the same operation ID and its receipt rewritten.
Deleting a receipt also retries through the capture layer's durable `opId`
guard. Inside the vault, an acknowledged receipt operation is not recreated if
its file is later deleted; external receipts can be recreated without duplicating
the capture. Keep request content and IDs stable; an ID reused for changed content
is invalid. Retrying after midnight preserves the original capture day.

Symlinked inbox/receipt directory components, request files, and receipt
targets below the inbox root are refused. One local run per vault and inbox root holds an exclusive lock under
`$XDG_STATE_HOME/jarvos/vault-mutations/` (default `~/.local/state/`), keyed
by the canonical vault and inbox path pair hash. Different inbox roots for the
same vault do not block each other. A lock belonging to a live local process is
kept; a dead local owner's lock is reclaimed, and other locks expire after ten
minutes. State must be outside the
vault. This local lock is not a distributed lock between synced hosts.

Normal output is one count summary line. `--json` returns `counts`,
`requests` containing `device`, `opId`, and `status`, and `inProgress`.
An unacknowledged receipt write also adds `receipt: { status, obsidian }` to
that request's run result. The command does not write a fallback receipt;
an absent receipt is retried on the next run with the same capture operation ID.
Incomplete requests appear only as counts/statuses, with no receipt or warning.
A held lock returns `inProgress: true` and `another run is in progress`.
Per-request failures and held locks exit 0; bad arguments or command-level
filesystem failures exit 1.

Desktop callers may import
`bridge/capture/src/inbox-apply.js` and await
`applyInbox({ vaultRoot, inboxRoot, limit, capture, mutationService, now })`.
`capture` defaults to `simpleCapture` and receives the selected vault, Notes, and Journal directories
and mutation service as its second argument. For the configured vault, these
directories come from `resolveConfig().paths.notes` and `paths.journal`; another
vault defaults to its `Notes` and `Journal` folders. `mutationService` defaults to the
configured vault mutation service for the selected vault; `now` defaults to a
function returning a new Date.
The fixed line-based parser uses Node's standard library and the existing
capture contracts, with no new dependencies. Hosts without `O_NOFOLLOW`
filesystem support fail closed.
