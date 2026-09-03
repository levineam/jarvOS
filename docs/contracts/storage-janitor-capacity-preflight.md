# Storage Janitor Capacity Preflight Contract

`@jarvos/storage-janitor` (`modules/jarvos-storage-janitor`) is a portable,
dependency-light core that decides whether a capacity-sensitive operation may
proceed, whether external reclaim should be recommended, and whether a
verified reclaim can back a one-time capacity reservation. It contains no
host policy, no concrete mutation authority, and no private machine or
provider detail, and no sensitive-term denylist: the generic structural
checks it performs (absolute-path and credential/secret patterns in string
values) are the portable minimum. A host adapter supplies the private
wiring -- including any private, provider- or OS-specific sensitive-term
scanner -- behind the three ports this contract defines.

## Typed records

### Capacity observation (`observation.js`)

```json
{
  "version": "jarvos-storage-janitor.observation.v1",
  "candidateSetId": null,
  "observedAt": "2026-09-03T12:00:00.000Z",
  "freshUntil": "2026-09-03T12:05:00.000Z",
  "bytesAvailable": 627048448,
  "bytesTotal": 1000000000000
}
```

`validateCapacityObservation(record, { now })` rejects a missing record,
missing or non-integer `bytesAvailable`/`bytesTotal`, a negative or
unsafe-integer byte count, `bytesAvailable` exceeding `bytesTotal`, and
`freshUntil` preceding `observedAt`. `observedAt` and `freshUntil` must be
UTC ISO-8601 timestamps with an explicit `Z` offset; a zoneless or
offset-relative timestamp is rejected. When `now` is supplied it
additionally rejects an `observedAt` in the future and a `freshUntil` that
has already passed. `now` is caller-supplied so the low-level validator
stays deterministic; `computeCapacityPreflight` requires a valid explicit
`now` and always supplies it.

### Capacity policy (`policy.js`)

Caller-injected thresholds under an opaque `policyId`: `requiredBytes` (a
positive safe integer -- a zero-byte requirement is not a capacity
requirement and is rejected) and `safetyMarginBytes` (a non-negative safe
integer). This package never invents a default threshold.

### Catalog candidate (`catalog.js`)

An opaque, caller-injected candidate with exact eligibility facts:

```json
{
  "version": "jarvos-storage-janitor.candidate.v1",
  "candidateId": "candidate:archive-001",
  "kind": "opaque-resource-kind",
  "estimatedBytes": 700000000,
  "protected": false,
  "unknown": false,
  "active": false,
  "dirty": false,
  "transitionNeeded": false
}
```

`isEligibleCandidate` requires every flag to be explicitly `false`; an absent
or non-boolean flag fails validation rather than defaulting to eligible.
Protected, unknown, active, dirty, and transition-needed candidates are
therefore preserved, never credited. `computeCandidateSetDigest` is a
deterministic, order-independent SHA-256 digest over
`{candidateId, kind, estimatedBytes}` used to fence reclaim evidence to an
exact candidate set. All digests in this contract are canonical: object keys
are sorted recursively before hashing, so semantically equal objects with
different insertion order hash identically, and every digest is rendered as
lowercase hex.

### External reclaim evidence (`reclaim.js`)

Evidence pairs a dry-run receipt and a terminal receipt, each shaped as:

```json
{
  "version": "jarvos-storage-janitor.reclaim-receipt.v1",
  "runId": "run:incident-001",
  "policyDigest": "<sha256>",
  "candidateSetDigest": "<sha256>",
  "fence": 1,
  "dryRun": true,
  "outcome": "verified",
  "bytesReclaimed": 700000000,
  "observedAt": "2026-09-03T12:06:00.000Z"
}
```

`validateExternalReclaimEvidence(evidence, expected)` requires: `expected`
carries an opaque `runId`, digest-shaped `policyDigest` and
`candidateSetDigest`, a non-negative integer `fence`, and a non-negative
integer `maxCreditableBytes` bounding the exact candidate set's summed
estimate; the dry-run receipt has `dryRun: true` and the terminal receipt
has `dryRun: false`; both receipts match the expected `runId`,
`policyDigest`, and `candidateSetDigest` exactly; both receipts match the
expected `fence` exactly (a lower fence is reported as stale, not merely
mismatched); and the dry run is observed strictly before the terminal
receipt. `outcome` is one of `verified`, `no-effect`, or `failed`.

A `failed` dry run is never creditable -- nothing was actually previewed --
and neither is a `failed` terminal receipt. A `no-effect` outcome always
credits zero bytes even if `bytesReclaimed` is nonzero. A `verified` outcome
with effect credits `min(terminalReceipt.bytesReclaimed,
dryRunReceipt.bytesReclaimed, expected.maxCreditableBytes)`: the dry run's
own preview and the caller-supplied maximum both bound the credit, so no
receipt can ever over-credit beyond what was previewed or beyond the exact
candidate set's estimate.

## Preflight decision (`preflight.js`)

`computeCapacityPreflight({ observation, policy, candidates, now })` returns
`{ ok, disposition, errors, pressure, candidateSetDigest }` where
`disposition` is one of:

- `proceed` -- `bytesAvailable >= requiredBytes + safetyMarginBytes` on a
  valid, fresh observation.
- `recommend_external_reclaim` -- insufficient capacity, but the supplied
  candidate set is exactly eligible and its summed `estimatedBytes` covers
  the deficit. `candidateSetDigest` is returned for fencing subsequent
  reclaim evidence.
- `blocked` -- a missing or malformed `now`, any other validation failure
  (invalid or stale observation, invalid policy, invalid or ineligible
  candidate set -- whose specific errors are preserved on the result),
  insufficient capacity with no usable candidate set, a candidate set that
  cannot bridge the deficit, or a byte-sum (required total or candidate
  total) that would overflow a safe integer.

Any invalid input fails closed to `blocked`; the caller never receives an
ambiguous verdict, and preflight never crashes on cyclic, too-deep, or
otherwise unserializable caller input -- it returns a typed `blocked` result
instead.

## Reservation persistence (`reservation-store.js`)

A one-time reservation is how this contract proves ENOSPC-safety without
depending on an unbounded new write: instead of writing a large probe file to
see whether it fits, a caller reserves a byte-accounted credit for exactly
the policy's required total.

The reservation-persistence port requires:

- **Atomic compare-and-set (or equivalent serialization).** A backend
  implements `load()`/`save(state, expectedRevision)`; `save` must reject a
  stale `expectedRevision` by throwing an error with
  `reservationConflict: true`. `checkReservationStoreConformance(createBackend)`
  proves this: starting from a valid empty state, it commits one write, then
  proves a second write against the now-stale precondition is rejected. A
  backend that silently overwrites fails conformance specifically because
  compare-and-set is absent, not because its initial state is malformed.
- **Explicit, typed capacity pool and limit.** `reserve({ poolId,
  capacityLimitBytes, ... })` requires both as explicit inputs; this package
  never assumes a default pool or limit. Reserving sums the already-active
  reservations for the same `poolId` and `fenceGeneration` (with overflow
  protection) and rejects a reservation that would push the total past
  `capacityLimitBytes` as `capacity_exceeded`, so two distinct reservations
  cannot double-commit the same headroom.
- **Durable idempotency keys with matching-replay semantics.** `reserve({
  idempotencyKey, ... })` is idempotent: a repeated key replays the existing
  reservation only if it is still `active`, its parameters (`amountBytes`,
  `fenceGeneration`, `poolId`, `capacityLimitBytes`) match exactly, and its
  fence is not stale relative to the store's current fence. A replay against
  a consumed or expired reservation, or a same-key replay with mismatched
  parameters, returns a typed blocked reason (`already_consumed`, `expired`,
  or `idempotency_key_conflict`) rather than silently returning the original
  reservation. Concurrent `reserve` calls for the same key race through the
  same compare-and-set loop and settle on exactly one reservation.
- **Monotonic fence generations.** The store tracks a monotonic
  `currentFence`; a `reserve` call with a `fenceGeneration` below it is
  rejected as `stale_fence`.
- **Bounded monotonic drawdown.** `consume({ reservationId, idempotencyKey,
  amountBytes, ... })` rejects an `amountBytes` exceeding the reservation's
  `amountBytes` as `drawdown_exceeds_reservation`.
- **One-time consumption, no double-spend.** A reservation moves
  `active -> consumed` exactly once. A repeat `consume` call with the same
  `idempotencyKey` replays the original result only if it requests the same
  `amountBytes`; a same-key replay with a different amount is rejected as
  `consume_amount_mismatch`. A repeat call with a different key is rejected
  as `already_consumed`.
- **Typed expiry/reap that actually persists.** Each reservation carries an
  `expiresAt`. `consume` or `reserve`'s replay path against an expired
  reservation transitions it to `expired` and commits that transition before
  reporting `expired` -- it never reports an expiry that was not actually
  persisted. `reap({ now })` transitions any due reservation to `expired`
  and is idempotent -- a second call reports no newly expired reservations.
- **Strict UTC clock inputs.** `now` (when supplied to `reserve`, `consume`,
  or `reap`) and `expiresAt` must be UTC ISO-8601 timestamps with an
  explicit `Z` offset; a zoneless or malformed timestamp is rejected as
  `invalid_request` and is never written into a persisted record.
- **Fail-closed recovery, never a throw.** No public method -- `reserve`,
  `consume`, `reap`, or `get` -- ever throws past its caller. If the backend
  cannot load or save state, it returns `{ ok: false, reason:
  'store_unavailable' }`. If compare-and-set contention persists past the
  retry budget, it returns `{ ok: false, reason: 'store_contention' }`
  instead of a generic unavailability. `get` validates its `reservationId`
  the same way and returns the same typed `{ ok, reservation }` /
  `{ ok: false, reason }` shape as the other methods.

`createMemoryReservationStore()` is the reference in-process implementation.
`createReservationStore({ backend, clock })` accepts any conforming backend.

## Ports (`ports.js`)

Three explicit ports carry every host- and provider-specific detail out of
this package. Each exchanges only the typed records above -- never a
command, credential, or private path:

- **Capacity observation port**: `observe(context) -> CapacityObservation`.
- **External reclaim port**: `proposeDryRun(request) -> ReclaimReceipt`,
  `execute(request) -> ReclaimReceipt`.
- **Reservation-persistence port**: `reserve`/`consume`/`reap`/`get`, matching
  `reservation-store.js`.

## Terminal outcomes (`outcomes.js`)

`TERMINAL_OUTCOMES` is `proceed`, `blocked`, `recommend_external_reclaim`,
`reserved`. `createCapacityPreflightReceipt(preflightResult, context)` wraps
a preflight decision into a typed receipt; it accepts only an actual
preflight disposition (`proceed` / `blocked` / `recommend_external_reclaim`)
and rejects `reserved`, which this function never produces. When `context`
supplies `policy`, `observedAt`, `runId`, and/or `fence`, the receipt binds
the decision to that policy's digest, the observation time, and the
run/fence identity.

`authorizeReclaimReservation({ evidence, expected, remeasurement, policy,
now, expiresAt, poolId, capacityLimitBytes, reservationStore })` requires an
explicit valid `now`, all of: valid evidence matching `expected` exactly
(run, policy digest, candidate-set digest, fence, and a `maxCreditableBytes`
bound), evidence crediting a positive number of bytes, and a fresh
remeasurement observation whose own preflight disposition is `proceed`. Only
then does it reserve the policy's full required total -- `requiredBytes +
safetyMarginBytes` -- through the injected reservation-persistence port,
against the explicit `poolId`/`capacityLimitBytes` inputs, keyed by a digest
of `expected` so repeated authorization attempts against the same evidence
settle on exactly one reservation. A candidate, policy, run, or fence
mismatch, an insufficient remeasurement, or a byte-sum overflow returns
`{ ok: false, outcome: 'blocked' }` without touching the reservation store.
Even if the injected `reservationStore` is off-contract and throws,
authorization fails closed to `blocked` rather than propagating the throw.
