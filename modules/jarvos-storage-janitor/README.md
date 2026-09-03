# @jarvos/storage-janitor

Portable, adapter-neutral capacity-safety contracts for jarvOS storage
janitors. This package owns the decision logic for whether it is safe to
proceed with a capacity-sensitive operation, whether external reclaim should
be recommended, and whether a verified reclaim can back a one-time capacity
reservation. It owns no host policy, no mutation authority, and no private
machine, provider, or filesystem detail. It also owns no sensitive-term
scanner: the generic structural checks here (absolute-path and
credential/secret patterns in string values) are the portable minimum: a
host adapter's private domain-specific denylist is a private concern layered
on top, never part of this package.

See `docs/contracts/storage-janitor-capacity-preflight.md` for the full
contract. In short:

- **Capacity observation** (`observation.js`) is a versioned, freshness-bound
  fact: `bytesAvailable`, `bytesTotal`, `observedAt`, `freshUntil`. Missing,
  stale, future, negative, unsafe-integer, or internally inconsistent
  observations fail validation. Structural validation stays clock-optional;
  the freshness check only runs when a caller-supplied `now` is provided.
- **Capacity policy** (`policy.js`) carries caller-injected thresholds
  (`requiredBytes`, `safetyMarginBytes`) under an opaque `policyId`. This
  package never invents a default threshold, and a zero-byte `requiredBytes`
  is rejected rather than trivially satisfied.
- **Catalog candidates** (`catalog.js`) are opaque, caller-injected records
  with exact eligibility flags (`protected`, `unknown`, `active`, `dirty`,
  `transitionNeeded`). Only a candidate with every flag explicitly `false` is
  eligible; an absent flag is an unknown fact, not permission.
- **Preflight** (`preflight.js`) computes `proceed`, `blocked`, or
  `recommend_external_reclaim` purely from a validated observation, policy,
  optional candidate set, and a required, explicit, valid UTC ISO `now`. A
  missing or malformed `now` fails closed to `blocked`, as does any byte-sum
  overflow. Any validation failure fails closed to `blocked` and preserves
  the underlying candidate/observation/policy errors.
- **External reclaim evidence** (`reclaim.js`) validates a paired dry-run and
  terminal receipt with dry-run-first, exact run/policy/candidate-set
  matching, and monotonic-fence enforcement. A failed dry run or a failed
  terminal receipt credits nothing; a no-effect receipt always credits zero;
  a verified receipt's credited bytes are bounded by both the dry run's own
  preview and a caller-supplied `maxCreditableBytes` tied to the exact
  candidate set, so no receipt can over-credit.
- **Reservation persistence** (`reservation-store.js`) is a public port
  contract plus a reference in-memory implementation and a conformance
  checker. It requires atomic compare-and-set (or equivalent serialization),
  durable idempotency keys, monotonic fence generations, bounded monotonic
  drawdown, typed expiry/reap, and fail-closed recovery. Every public method
  -- including `get` -- validates its input, is guarded against backend
  failure, and returns a typed result (`store_unavailable` for a failing
  backend, `store_contention` for exhausted compare-and-set retries) rather
  than throwing. Idempotent replay only succeeds for a still-active
  reservation with matching parameters and a non-stale fence; a consumed,
  expired, or mismatched replay is a typed blocked result. The capacity pool
  (`poolId`) and its limit (`capacityLimitBytes`) are explicit, caller-typed
  inputs; reserving against the same pool and fence subtracts already-active
  reservations so two distinct reservations cannot double-commit the same
  headroom.
- **Ports** (`ports.js`) define the three explicit boundaries this package
  depends on -- capacity observation, external reclaim provider, and
  reservation persistence -- as typed method-shape contracts. None receives a
  command or a private path. `assertReservationPort` is used internally at
  the one seam where this package accepts a caller-supplied port; the other
  two assertions exist for a host adapter to self-verify its own port
  implementation.
- **Outcomes** (`outcomes.js`) derive the typed terminal receipts.
  `createCapacityPreflightReceipt` wraps only an actual preflight
  disposition (never `reserved`) and, when supplied, binds the receipt to a
  policy digest, observation time, and run/fence identity.
  `authorizeReclaimReservation` proves ENOSPC-safety without an unbounded new
  write by reserving the policy's full required total (including its safety
  margin) once matched reclaim evidence and a fresh, sufficient
  remeasurement both hold, requires an explicit valid `now`, and fails closed
  -- never throwing past its caller -- even if the injected reservation port
  is off-contract.

This package installs no dependencies and starts no child process. It is
independent of provider, AI harness, tracker, scheduler, filesystem layout,
OS, and machine; a host adapter supplies the private observation, reclaim,
and persistence details behind the three ports above.
