# @jarvos/active-assistant

`@jarvos/active-assistant` is the pure, jarvOS-owned service contract for
proactive assistance. It intentionally owns decisions and receipts, not a
resident process. Every exported function is deterministic and performs no
file, network, scheduler, credential, media, or provider operation.

## Boundary

The service owns:

- evidence, candidates, and governed promotion;
- preparation and receipt-based evaluation of a scheduled delivery;
- provider catalog, selection proposal, compare-and-swap settlement, and
  failure records;
- portable conversation identities, mappings, interaction receipts, and
  lifecycle receipts; and
- approval, ambiguity, idempotency, and fail-closed decisions.

A harness bridge may only declare and implement these operations:

`transport`, `native_session_mapping`, `media_reply`, `event_bridge`, and
`receipt_production`.

It retains native session and reply mechanics. It submits only redacted,
validated mapping, interaction, and lifecycle receipts to this contract. The
contract does not name, load, configure, or start a particular harness.

## Governed flow

1. `createCandidate` accepts validated evidence records and makes a candidate
   that refers to evidence by ID and digest only.
2. `promoteCandidate` requires complete evidence, a matching candidate
   generation, a candidate-and-policy-bound unambiguous approval scoped to
   `promotion`, and a policy revision. Otherwise it returns a fail-closed
   reason and creates nothing.
3. `prepareDelivery` requires a promoted candidate, an unexpired schedule,
   portable conversation identity, a catalog-registered selected provider
   generation, and an unambiguous approval bound to that exact delivery. It
   creates a deterministic prepared record; it does not deliver.
4. `evaluateDelivery` accepts a lifecycle receipt only once its schedule is
   due, and binds it to a declared receipt-producing bridge and that bridge's
   portable conversation mapping. A previously seen idempotency key is
   replay-safe; an early, expired, malformed, or incorrectly bound receipt is
   rejected.

Provider selection is similarly data-only: `settleProviderSelection` accepts a
registered proposal only if its expected generation matches the incumbent. A
failed outcome keeps the incumbent selection and generation exactly; a
qualified outcome needs `provider_selection` approval bound to the catalog and
proposal and produces a new generation, making replay stale. The exported
binding helpers calculate the digest an approval must carry; an approval cannot
be replayed across a different candidate, provider proposal, or delivery.

## Privacy and safety

Records carry opaque references and SHA-256 payload digests rather than message
content, credentials, paths, executable details, raw outputs, or provider
responses. Closed-field validation rejects unknown authority-shaped fields.
No default catalog entry makes an availability or authentication claim.

The package is a contract, not a migration or activation path. Hosts remain
responsible for scheduling, transport, native mappings, media/reply behavior,
event bridging, and creating their own receipts.

The JSON Schema is a portable structural envelope. The exported validators are
the authoritative fail-closed layer for calendar-valid UTC timestamps, duplicate
identities, relational schedule checks, path-safe strings, approval bindings,
and cross-record bridge receipt bindings.
