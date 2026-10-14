# Projects context handoff

The public Projects package owns the `jarvos.projects-context/v1` contract and
its bounded query, capability, record, activity, and provider validation. A
private host may supply a provider and Active Assistant adapter, but that
integration is a separate deployment dependency.

The boundary between them is the metadata-only
`jarvos.projects-context-handoff/v1` receipt exported by
`projects-context-handoff.js`. A ready receipt binds:

- the public contract and compatible revision;
- the public package digest;
- the private provider contract and revision;
- the consumer and named-profile revision; and
- capability receipt metadata and digest.

The receipt contains no private paths, secrets, prompts, raw provider payloads,
ledger rows, Journal content, or rendered context. A blocked receipt records
only a bounded blocker code. Handoff IDs are content-bound, so changing a
receipt field invalidates its identity.

The private checkout owns the host configuration, provider module, capability
secret, state root, Active Assistant adapter, and any private tests. It must
pin those artifacts to a receipt before a consumer cutover. If the private
checkout or receipt is missing, stale, or mismatched, public contract tests
remain runnable but the cutover is blocked; no consumer may silently fall back
to raw Beads, Todo, Paperclip, release, or Journal project state.

This is an integration dependency, not a second Projects authority. The
Projects package remains the only owner of durable project/outcome identity and
bounded context semantics.
