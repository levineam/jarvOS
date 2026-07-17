# jarvOS Control Plane

## Authenticated application-service boundary

Public transports are adapters, not authorization authorities. They submit a
credential and a structured `createRequest` envelope to the core application
service. The service resolves that credential to an opaque trusted principal,
then overwrites caller-supplied principal and capability fields before policy or
projection work. Read/list/inspect/evidence projections are filtered by that
principal's capabilities and sensitivity ceiling; adapter extensions never
appear in public projections.

Approvals are one-time attestations bound to the exact action key, required
approver capability, expiry, and current mutation fence. A replay, replacement
command, expired approval, or stale concurrent fence fails closed and must
start a fresh authorization path.

The jarvOS Control Plane is the portable coordination layer for machine-wide AI
operations. It discovers resources, compares desired and observed state, applies
policy, arbitrates mutation ownership, dispatches bounded commands to domain
managers, and records independently verified evidence.

It is not a second task tracker or a private host. Domain authorities stay in
their source systems. Paperclip, when installed, remains execution truth. Private
machine paths, credentials, and adapter mappings stay outside the public module.

## Boundary

The public core owns:

- versioned contracts for records, managers, requests, commands, evidence,
  schedules, leases, and findings
- deterministic registry, policy, reconciliation, lease, fence, and storage
  primitives
- dependency-free reference implementations for memory and filesystem stores
- public docs and tests that prove fail-closed behavior

Domain managers own:

- authoritative observation ports
- adapter-specific authentication and capability mapping
- execution of declared mutation classes
- independent verifier/postcondition ports
- domain-specific evidence projection and source-route integration

Installed hosts own:

- configured roots and enabled managers
- credential providers and secret references
- scheduler authority
- Paperclip or equivalent tracker projection
- private policies and profile-level safety gates

## Lifecycle

1. A human, agent, schedule, or system creates a structured request.
2. The request names principal, actor kind, resource scope, mutation class,
   desired generation, command spec, constraints, budget, and lifecycle behavior.
3. Policy evaluates that exact request and returns `allow`, `deny`,
   `require_approval`, or `defer`.
4. Registry selects the one executable manager that owns the mutation key.
5. The store dedupes equivalent authorized commands by action key.
6. The store grants a compare-and-set lease and monotonic fence.
7. The manager executes only after validating the fence at the final side-effect
   boundary, and reconciliation rechecks it after execution before recording an
   `executed` transition.
8. The verifier reads authoritative current state independently; malformed or
   failed verifier output is terminal `unverifiable` and releases the lease.
9. Evidence is committed only if the lease and fence are still current.
10. The final projection references the durable command/evidence identity.

## Fail-Closed Rules

- Unsupported or malformed contract versions do not execute; compatible versions
  are selected from an explicit supported-version table.
- Data-only or untrusted managers may be displayed for health, but mutation code
  is not called.
- Conflicting ownership for the same `(machine, resource, mutation class)` is a
  visible conflict and blocks executable registration.
- Denied, deferred, approval-pending, revoked, expired, stale, superseded, or
  unverifiable requests cannot inherit authority from an equivalent command.
- If read authorization or sensitivity filtering cannot be evaluated, surfaces
  expose only non-sensitive health.
- If target-side fencing or equivalent compare-and-set cannot be proven,
  takeover is prohibited while an uncertain side effect may remain in flight.

## Reference Store

The reference store is intentionally simple:

- write-ahead, framed, fsynced append-only journal entries with stable digests
- replay from a checkpoint plus the journal at startup; an incomplete final
  frame is truncated and fsynced before a later append, while an invalid
  complete frame fails closed
- atomic stale-lock takeover keyed to the validated lock inode, with PID reuse
  detection via a process-start marker
- bounded checkpoint compaction that retains current records and evidence digests
- current record projections derived from the journal
- compare-and-set leases keyed by independent mutation resource
- monotonic fences per mutation key
- evidence commits rejected when a writer presents a stale fence

This is enough for deterministic tests and portable examples. Production hosts
may replace the store, but they must preserve the same ordering, lease, fence,
and recovery semantics.

## Portability Pattern

Someone adopting this pattern in another AI operating system can keep the same
shape:

1. Define a small portable contract for desired state, observations, requests,
   commands, evidence, managers, schedules, and leases.
2. Make domain managers declare what they observe, what they mutate, and how
   they verify.
3. Authorize every request before dedupe.
4. Use deterministic action keys for idempotency.
5. Acquire a fenced mutation lease before side effects.
6. Verify through an independent read path.
7. Store adapter/private fields as extensions and strip them from unauthorized
   projections.

That keeps the system generic over a specific tracker, runtime, vault, or AI
harness while still making autonomous work auditable and recoverable.
