# Project intent and coding follow-through

These optional library integrations let a trusted host explain unclear project
intent and unfinished coding work through the existing Projects context packet.
They do not activate a runtime, create work items, or dispatch an executor.

## Intent-gap attention

The Projects package exports `./intent-gap-attention`:

- `deriveIntentGapAttention` examines active/planned canonical records for an
  absent, empty, or placeholder (`-`) goal or definition of done.
- `intentSourceDescriptorDigest` binds a source's proposed fields to its canonical
  record, revision, registry generation, source reference/digest, source role,
  scope, disposition, promised resolution time, and next owner.
- `acknowledgeIntentGapAlerts` acknowledges delivered entries for one consumer.
  The host supplies durable `has`/`mark` storage. The memory implementation is for
  tests; normal context reads do not acknowledge notifications.

The host first captures only authorized, explicitly linked sources and admits
their descriptor digest through the existing inference-evidence authority. Pass
each descriptor and its admitted `evidence` to `buildContextPacket` as
`intentGaps: { sources, sourceAuthority }`. This option belongs to protected host
construction, not caller-supplied tool arguments. Unrelated source descriptors are
filtered before validation; public-redaction packets omit intent-gap details.

A matching source can produce a proposed patch, but applying it still requires
the existing protected owner application and compare-and-swap path. Unresolved,
stale, deferred, and narrower-source dispositions must remain visible without
generating replacement prose. Omitting the integration emits
`intent-gap:omitted`; it does not pretend every project has complete intent.

The packet uses its existing `attention` summary shape and the existing assistant
renderer. Hosts needing field-level proposals use the derived result locally;
the bounded packet carries the disposition, next owner, and evidence references.

## Coding follow-through

`@jarvos/coding` exposes `createWorkFollowThrough`. Its backing work-run store
provides `bindFollowThrough` and `getFollowThrough`. A binding retains an outcome
ID plus existing references to the executor owner, harness/workspace, coding run,
Beads next-action Todo, and resumption trigger. Binding requires the current run
owner and fence; conflicting outcome/run bindings are refused. After a lease
renewal, the same owner can explicitly renew the unchanged references using the
current fence; previous lease bindings remain in history.

Construct the reader with a work-run store and trusted host receipt resolvers.
The native invocation receipt must match the binding's run, owner,
harness/workspace, and fence, and carry a matching routing decision. A direct hook
test, assignment, or source merge is insufficient. Resolver functions are host
authority seams: they must load qualified evidence, never echo caller claims.

`summarize({ outcomeId })` derives a non-authoritative disposition. Failed or
blocked runs cannot appear running or accepted. Accepted completion requires
native invocation evidence together with a completed coding run's accepted
terminal evidence for the same fence. Unsupported capability is a visible
non-success disposition accepted through the managed-runtime admission owner
with an admission ID and the same run/owner/workspace/fence references.

`await toProjectsSummary({ outcomeId, canonicalId, observedAt })` derives status
internally from the trusted store and resolvers, then returns the existing
Projects provider summary shape. It does not accept a caller-provided status or
derived result. The host must admit that summary through its existing provider
authority, preserving the canonical outcome reference and normal capability
scope. This reader does not change coding submission or completion authority.

## Installation evidence

Package tests qualify library behavior only. Before a host enables these inputs,
its runtime owner must admit the compatible public/private/profile/capability
combination. Verify actual bounded Projects and assistant readback, durable alert
suppression across restart, and a native invocation plus resumption through the
referenced existing trigger. Missing evidence remains an explicit unavailable or
unsupported result. Journal projection retains its separate owner and consumes
accepted project activity, not intent-gap or follow-through context reads.
