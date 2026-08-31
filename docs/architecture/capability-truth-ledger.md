# Capability truth ledger

The capability truth ledger is repository truth tooling. It records what the
project asserts about each capability and points to the evidence behind the
assertion. It is not discovery, not an activation probe, and not proof that a
capability runs anywhere. Reading the ledger tells you what has been claimed and
where to check it; validating it inspects no repository, host, process, or
network.

## Schema

A ledger is `{ schemaVersion, records }` with schema version
`jarvos.capability-ledger.v1`. Unknown schema versions, unknown enum values, and
unknown fields fail closed at both the top level and inside each record.

## Independent truth dimensions

Each record carries six independent dimensions. A capability can be strong on
one and absent on another, so the validator never derives one from another:

| Dimension | States |
| --- | --- |
| `specification` | `absent`, `draft`, `canonical` |
| `implementation` | `absent`, `partial`, `complete` |
| `repository` | `local-only`, `draft-pr`, `merged`, `released` |
| `verification` | `untested`, `fixture-proven`, `clean-install-proven`, `live-canary-proven` |
| `activation` | `inactive`, `test-fixture`, `disposable`, `enrolled-host`, `production`, `unknown` |
| `authority` | `none`, `read-only`, `proposed`, `active`, `conflicted` |

The activation vocabulary is generic public-product language. It never names a
specific operator's machines.

## Records and evidence

Every record also has a bounded lowercase `capabilityId`, a bounded `title`, an
ISO `assertedOn` date, optional bounded `notes`, and a non-empty `evidence`
array. Each evidence pointer is `{ type, ref }`, where type is `repo-path`,
`pull-request`, `test`, `document`, or `commit`. A reference is a bounded,
repository-relative pointer: it cannot be absolute, cannot contain `..`
traversal, and cannot carry a `file:` or other URI scheme.

## Invariants

- Duplicate capability IDs fail.
- The six dimensions stay independent.
- Evidence references stay relative and scheme-free.
- The validator performs no I/O; it only checks shape and bounds.
- The ledger is an assertion set. A record is a claim with evidence pointers,
  not a discovered fact and not an activation proof.

## Seed ledger

The tracked `capability-ledger.json` seed describes only this local foundation
slice. Its identity, truth-ledger, candidate-envelope, and promotion-receipt
contracts are asserted at `implementation: partial` and `verification:
fixture-proven` because their validators and tests exist but no installed
product consumer activates them. Every seed record is `repository: local-only`,
`activation: inactive`, and `authority: none`.
