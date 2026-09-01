# Candidate Envelope

The candidate envelope is a portable `@jarvos/ambient` contract for a
non-authoritative proposal bound to eligible source evidence. It is a value,
not a record. It carries no mutable status and cannot itself represent
promotion, rejection, completion, or recall. A candidate never satisfies
recall, completion, a Project identity, or authoritative memory.

Schema version: `jarvos.candidate.v1`.

The validator reads no host, process, environment, network, store, or Vault
state. The module exports no recall, completion, write, store, or promotion
function. Ineligible material—secret privacy, untrusted recall, tool output,
unknown ownership, or unknown trust—is rejected before a candidate is
constructed and is therefore not representable in this envelope.

## Shape

`assertCandidate()` returns an immutable deep-cloned candidate object with
exactly these fields. `validateCandidate()` only validates an input and never
mutates or freezes it. Any unknown top-level or nested field fails closed.

| Field | Requirement |
| --- | --- |
| `schemaVersion` | `jarvos.candidate.v1` |
| `candidateId` | identity of kind `candidate` |
| `candidateType` | `note-draft`, `journal-suggestion`, `memory-unit`, `ontology-inquiry`, `project-signal`, `skill-proposal`, or `work-proposal` |
| `authority` | required literal `non-authoritative` |
| `sources` | non-empty, bounded array of `{ sourceEventId, evidenceDigest }` |
| `privacyTier` | `public`, `local-private`, `private`, or `sensitive` |
| `sourceTrust` | `user-authored` or `assistant-derived` |
| `construction` | `{ extractorId, extractorVersion, eligibilityPolicyId }` |
| `dedupeKey` | bounded opaque string |
| `createdAt` | ISO instant |
| `expiresAt` | ISO instant later than `createdAt` |
| `proposal` | bounded `{ title, summary }` |

Each `sources` entry contains only `sourceEventId` (identity of kind
`source-event`) and `evidenceDigest` (`sha256:<64 hex>`). Source-event IDs
cannot repeat within a candidate. Candidates carry evidence digests and source
identity, never raw evidence.

`construction.eligibilityPolicyId` is an identity of kind `policy` naming the
policy under which the extractor judged the material eligible. `proposal` is
limited to a bounded `title` and `summary` and contains no raw transcript, note
content, recall text, completion output, or destination.

## Invariants

- An asserted envelope is immutable and has no mutable `status`.
- `authority` is the literal `non-authoritative`; there is no authoritative
  member.
- `secret` privacy and any trust other than `user-authored` or
  `assistant-derived` are rejected.
- Fields such as `authoritative`, `verified`, `completed`, `status`,
  `destination`, `recallText`, `text`, `content`, and `transcript` are unknown
  and rejected at every level.
- A `project-signal` may reference source evidence but cannot mint or replace a
  Project identity; no Project identity is a candidate field.

## Identity grammar

Ambient has no control-plane dependency, so it checks an already-issued
identifier with a small private shape test. The grammar is
`jarvos:<kind>:<namespace>:<opaque>`, all lowercase and at most 256 characters,
with `namespace` and `opaque` each matching
`[a-z0-9][a-z0-9._-]{0,63}`. It never resolves, dereferences, normalizes, or
infers an identifier. Cross-contract conformance fixtures keep this grammar
aligned with `@jarvos/control-plane`.

The contract is reachable from `@jarvos/ambient`, `@jarvos/ambient/intent`, and
`@jarvos/ambient/intent/candidate-contract`.
