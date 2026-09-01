# Product realization foundation v1 plan

Status: implemented as a draft-PR contract slice; no runtime behavior is authorized

Base: `af427a68bbe88c0f08dc516356e3fee55cf41b89` (`origin/main`)

Branch: `feat/product-realization-foundation-v1`

This plan is the integrated result of a read-only Fable 5/high first pass and a
Codex review against the exact base tree and current open pull-request file
sets. It implements the first safe slice from the parent Overseer roadmap. It
does not authorize a push, pull request, merge, release, installation,
activation, scheduler, runtime change, Vault operation, or private host
mutation.

## Goal

Add four fail-closed, machine-readable foundation contracts and the minimum
product-boundary documentation needed to describe them:

1. a capability truth ledger that separates specification, implementation,
   repository, verification, activation, and authority state;
2. opaque namespaced identities for portable jarvOS entities;
3. a non-authoritative candidate envelope bound to eligible source evidence;
   and
4. a cross-surface promotion receipt envelope that reports outcome and
   destination-specific reversibility honestly.

These are contracts, fixtures, tests, and documentation only. Consumers and
stateful behavior are deliberately deferred.

## Scope decision

All four contract families belong in this slice because they refer to one
another and are the smallest coherent foundation for the governed candidate
lifecycle. The capability ledger records the truth about the contracts;
candidates and receipts reference stable identities; and receipts connect
non-authoritative candidates to a destination attempt without implementing the
attempt.

Documentation reconciliation is limited to:

- the product-boundary document; and
- the external-integration document's intentional-capture and non-goal
  language.

The broader README, strategy, packaging, onboarding, and public-baseline
rewrite remains separate.

## Done criteria

1. Each contract has a validator, exported constants, documentation, positive
   fixtures, and negative fixtures.
2. Unknown schema versions, enum values, and top-level fields fail closed.
3. The candidate envelope can represent only eligible, non-authoritative
   candidates and contains no mutable promotion status.
4. The receipt envelope distinguishes a recorded attempt from a successful
   mutation and never implies universal rollback.
5. Project identities can be referenced but no generic function can mint them.
6. The seed capability ledger validates and describes this local branch
   honestly: specification `draft`, repository `draft-pr`, activation `inactive`, authority `none`,
   implementation `partial`, verification `fixture-proven`.
7. The cross-contract fixture suite runs through the existing control-plane
   test glob, so root `package.json` is unchanged.
8. The exact-base test suite passes before and after implementation.
9. The final diff contains no writers, services, schedulers, network clients,
   setup behavior, runtime activation, environment-derived identity, personal
   data, or production evidence.
10. Work is committed locally in reviewable boundaries and is not pushed.

## Constraints

- Work only in the dedicated `jarvOS-product-foundation` worktree.
- Add no npm dependency.
- Use existing CommonJS validator conventions.
- Do not add a package merely to hold contracts.
- Do not change root `package.json`; open pull requests #252, #253, and #255
  already touch it.
- Do not touch bootstrap, CLI, Doctor, profiles, setup scripts, hooks, runtimes,
  templates, schedulers, adapters, source-event producers, stores, protected
  writers, or provider configuration.
- Do not implement identifier issuance. The identity contract validates opaque
  identifiers; each owning subsystem will later define how it issues them.
- Do not derive identity from a hostname, filesystem path, username, MAC
  address, environment variable, or other private/unstable machine property.
- Do not implement authority records, authority transfer, expiring leases, or
  automatic failover.
- Do not put raw transcript text, Vault content, real paths, personal data,
  secrets, or deployment receipts in code, fixtures, docs, or test output.
- Do not treat the capability ledger as discovery or proof. Its records are
  assertions with evidence pointers.
- Do not let a candidate satisfy recall, completion, Project identity, or
  authoritative memory.
- Do not claim rollback when the destination offers only supersession,
  retraction, or no reversal.

## Ownership decisions

| Contract | Owner | Location |
| --- | --- | --- |
| Opaque identity | `@jarvos/control-plane` | `modules/jarvos-control-plane/src/identity.js` |
| Promotion receipt | `@jarvos/control-plane` | `modules/jarvos-control-plane/src/promotion-receipt.js` |
| Candidate envelope | `@jarvos/ambient` | `modules/jarvos-secondbrain/packages/jarvos-ambient/src/intent/candidate-contract.js` |
| Capability ledger | Repository truth tooling | `scripts/lib/capability-ledger.js` and root `capability-ledger.json` |
| Cross-contract conformance | Control-plane test lane | `modules/jarvos-control-plane/test/foundation-contracts-conformance.test.js` |

The control plane already owns shared governance vocabulary. Ambient already
owns CaptureEvent. Repository release tooling already lives under
`scripts/lib`. Existing destination receipts remain authoritative for their
own evidence; the new receipt is a bounded cross-surface envelope, not a
replacement.

## Identity contract

Schema version: `jarvos.identity.v1`.

Identifier grammar:

```text
jarvos:<kind>:<namespace>:<opaque>
```

Requirements:

- the entire identifier is lowercase and no more than 256 characters;
- `namespace` and `opaque` each match
  `[a-z0-9][a-z0-9._-]{0,63}`;
- no segment contains whitespace, control characters, path separators,
  percent-encoding, or an additional colon;
- the allowed kinds are `mind`, `installation`, `host`, `harness-instance`,
  `session`, `source-event`, `candidate`, `artifact`, `project`, `policy`, and
  `receipt`;
- an optional expected-kind argument must match exactly;
- parsing and validation never resolve, dereference, normalize, or infer an
  identifier; and
- no minting API is included in v1.

The owning issuer controls stability and idempotency. In particular, the
Projects provider owns `project` issuance, source adapters own source-event and
session mapping, and a future enrollment flow owns mind, installation, host,
and harness-instance issuance.

Exports:

- `IDENTITY_SCHEMA_VERSION`
- `IDENTITY_KINDS`
- `parseIdentity(value)`
- `validateIdentity(value, expectedKind)` returning an error array
- `assertIdentity(value, expectedKind)` throwing on invalid input

## Capability ledger contract

Schema version: `jarvos.capability-ledger.v1`.

Ledger shape:

```text
{ schemaVersion, records }
```

Every record contains:

- `capabilityId`: bounded lowercase slug;
- `title`: bounded non-empty string;
- `specification`: `absent`, `draft`, or `canonical`;
- `implementation`: `absent`, `partial`, or `complete`;
- `repository`: `local-only`, `draft-pr`, `merged`, or `released`;
- `verification`: `untested`, `fixture-proven`, `clean-install-proven`, or
  `live-canary-proven`;
- `activation`: `inactive`, `test-fixture`, `disposable`, `enrolled-host`,
  `production`, or `unknown`;
- `authority`: `none`, `read-only`, `proposed`, `active`, or `conflicted`;
- `evidence`: a non-empty array of bounded `{ type, ref }` pointers, where type
  is `repo-path`, `pull-request`, `test`, `document`, or `commit`;
- `assertedOn`: an ISO calendar date; and
- optional bounded `notes`.

The activation vocabulary is generic public-product language. It must not name
an operator's machines.

Invariants:

- duplicate capability IDs fail;
- all six truth dimensions remain independent;
- an evidence reference cannot be absolute, contain traversal, or contain a
  `file:` URI;
- the validator does not inspect a repository, host, process, or network;
- the ledger is an assertion set, not discovery and not activation proof; and
- the seed contains only the four contracts in this slice.

The seed records use `implementation: partial` because validators and fixtures
exist but no product consumer does. While this work remains in a draft pull
request, specification is `draft`, verification is `fixture-proven`, repository
is `draft-pr`, activation is `inactive`, and authority is `none`.

## Candidate envelope contract

Schema version: `jarvos.candidate.v1`.

`assertCandidate()` returns an immutable deep clone. The envelope has no
mutable `status` and cannot itself record promotion, rejection, completion, or
recall.

Required fields:

- `schemaVersion`;
- `candidateId`, kind `candidate`;
- `candidateType`: `note-draft`, `journal-suggestion`, `memory-unit`,
  `ontology-inquiry`, `project-signal`, `skill-proposal`, or `work-proposal`;
- `authority`: required literal `non-authoritative`;
- `sources`: a non-empty array of `{ sourceEventId, evidenceDigest }`, where
  the event ID has kind `source-event` and the digest is `sha256:<64 hex>`;
- `privacyTier`: `public`, `local-private`, `private`, or `sensitive`;
- `sourceTrust`: `user-authored` or `assistant-derived`;
- `construction`: `{ extractorId, extractorVersion, eligibilityPolicyId }`,
  with a policy-kind identifier;
- `dedupeKey`: bounded opaque string;
- `createdAt` and `expiresAt`: ISO timestamps, with expiry after creation; and
- `proposal`: bounded `{ title, summary }` containing no raw transcript field.

Invariants:

- `secret`, untrusted recall, tool output, unknown ownership, and unknown trust
  are not candidate values; they are rejected before candidate construction;
- source-event IDs cannot repeat;
- candidates contain evidence digests and source identity, not raw evidence;
- fields such as `authoritative`, `verified`, `completed`, `status`,
  `destination`, and `recallText` are unknown and rejected;
- the module exports no recall, completion, write, store, or promotion
  function; and
- `project-signal` may reference source evidence but cannot mint or replace a
  Project identity.

## Promotion receipt envelope contract

Schema version: `jarvos.promotion-receipt.v1`.

Required fields:

- `schemaVersion`;
- `receiptId`, kind `receipt`;
- `operation`: `promotion`, `supersession`, `retraction`, `rollback`, or
  `correction`;
- `outcome`: `committed`, `already_satisfied`, `deferred`, `conflict`, or
  `failed`;
- `candidateIds`: candidate-kind identifiers;
- `policyId`: policy-kind identifier;
- `authorization`: `{ mode }`, where mode is `user-reviewed` or
  `policy-automatic`;
- `destination`: `{ surface, artifactId, revisionBefore, revisionAfter,
  reversalMode }`;
- `recordedAt`: ISO timestamp; and
- `evidence`: a non-empty array of `{ type, ref, digest }`, using bounded
  logical references and `sha256:<64 hex>` digests.

Destination surfaces are `notes`, `journal`, `memory`, `ontology`, `projects`,
`skills`, and `work`. `artifactId` is an artifact-kind identity.
`reversalMode` is `rollback`, `retraction`, `supersession`, or `none`.

Optional `predecessorReceiptId` is required for supersession, retraction,
rollback, and correction. It has kind `receipt`.

Invariants:

- promotion requires at least one candidate ID;
- non-promotion operations require a predecessor receipt;
- `committed` requires `revisionAfter`;
- `deferred`, `conflict`, and `failed` cannot claim `revisionAfter`;
- `already_satisfied` reports no new revision and cannot claim mutation;
- `reversalMode` describes how the **resulting destination state may later be
  changed**; it does not prove that the current operation was reversible or
  that a future reversal will succeed;
- the validator does not try to prove destination-specific reversal semantics;
  the destination's own receipt and protected writer retain that ownership;
- `policy-automatic` is representable but does not authorize automation; an
  admitting consumer must enforce the currently approved policy posture;
- raw destination receipts, content, paths, secrets, and transcript text are
  not included; and
- a receipt with a failed or deferred outcome is evidence of an attempt, not
  evidence of a successful promotion.

## Fixture matrix

Fixtures live under `tests/fixtures/foundation-contracts/` with a manifest that
names the contract, file, and expected outcome.

Positive cases:

- every identity kind;
- a multi-record generic capability ledger;
- a `memory-unit` candidate;
- a `project-signal` candidate with no minted Project identity;
- committed and failed promotion receipts;
- a supersession receipt with a predecessor; and
- a committed destination whose future reversal mode is `none`.

Negative cases:

- unknown schema version, enum value, identity kind, or top-level field for
  every contract;
- uppercase, path-like, percent-encoded, overlong, and extra-colon identities;
- duplicate ledger capability IDs, missing evidence, absolute/traversal/file
  evidence references, and a machine-specific activation value;
- authoritative candidate, candidate `status`, empty or duplicate sources,
  bad digest, `secret` privacy, untrusted/tool/unknown trust, missing expiry,
  expiry before creation, and raw transcript/content field;
- promotion without a candidate, non-promotion without a predecessor,
  committed receipt without `revisionAfter`, non-committed receipt with
  `revisionAfter`, unknown destination surface/outcome/reversal, and malformed
  candidate, policy, artifact, or receipt identity.

All fixture values are synthetic and generic.

## Exact files

Add:

- `docs/plans/2026-08-31-feat-product-realization-foundation-v1-plan.md`
- `modules/jarvos-control-plane/src/identity.js`
- `modules/jarvos-control-plane/src/promotion-receipt.js`
- `modules/jarvos-control-plane/test/identity.test.js`
- `modules/jarvos-control-plane/test/promotion-receipt.test.js`
- `modules/jarvos-control-plane/test/foundation-contracts-conformance.test.js`
- `modules/jarvos-secondbrain/packages/jarvos-ambient/src/intent/candidate-contract.js`
- `modules/jarvos-secondbrain/packages/jarvos-ambient/test/candidate-contract.test.js`
- `modules/jarvos-secondbrain/docs/contracts/CANDIDATE_ENVELOPE.md`
- `scripts/lib/capability-ledger.js`
- `capability-ledger.json`
- `docs/architecture/capability-truth-ledger.md`
- `tests/fixtures/foundation-contracts/manifest.json`
- bounded valid and invalid JSON fixtures named by the manifest.

Change additively:

- `modules/jarvos-control-plane/src/index.js`
- `modules/jarvos-control-plane/package.json`
- `modules/jarvos-control-plane/README.md`
- `modules/jarvos-secondbrain/packages/jarvos-ambient/src/intent/index.js`
- `modules/jarvos-secondbrain/packages/jarvos-ambient/package.json`
- `docs/architecture/product-category-and-boundaries.md`
- `docs/architecture/secondbrain-external-integrations.md`
- `tests/secondbrain-external-integrations-doc-test.js` only as required to
  enforce the reconciled wording.

Do not change root `package.json`.

## Ordered steps and verification

### Step 1 — Baseline and plan commit

1. Verify branch, worktree, and exact base.
2. Install locked dependencies only inside this worktree with `npm ci`.
3. Run `npm test` at the exact base.
4. If baseline is red, stop; do not fix unrelated behavior.
5. Commit this plan artifact before implementation.

Verification:

```text
git rev-parse HEAD
git status --short --branch
npm test
```

### Step 2 — Identity contract

Implement the identity validator, exports, module tests, and README section.
Do not include minting, machine discovery, or environment access.

Verification:

```text
node --test modules/jarvos-control-plane/test/identity.test.js
node --test modules/jarvos-control-plane/test/*.test.js
```

### Step 3 — Capability ledger

Implement the ledger validator, generic contract documentation, and four-record
seed ledger.

Verification:

```text
node -e "require('./scripts/lib/capability-ledger').assertCapabilityLedger(require('./capability-ledger.json'))"
```

Also prove one malformed in-memory ledger is rejected.

### Step 4 — Candidate envelope

Implement the candidate validator, immutable assertion result, ambient exports,
tests, and contract documentation.

Verification:

```text
node --test modules/jarvos-secondbrain/packages/jarvos-ambient/test/candidate-contract.test.js
npm test --prefix modules/jarvos-secondbrain/packages/jarvos-ambient
```

### Step 5 — Promotion receipt envelope

Implement the receipt validator, exports, tests, and README section.

Verification:

```text
node --test modules/jarvos-control-plane/test/promotion-receipt.test.js
node --test modules/jarvos-control-plane/test/*.test.js
```

### Step 6 — Fixture conformance

Add the manifest and JSON fixtures. The control-plane conformance test must
load each fixture, dispatch it to the selected validator, and match the expected
result. It must also validate the tracked seed ledger.

Verification:

```text
node --test modules/jarvos-control-plane/test/foundation-contracts-conformance.test.js
node --test modules/jarvos-control-plane/test/*.test.js
```

### Step 7 — Product-boundary documentation reconciliation

Add a bounded product-boundary section for candidates, receipts, identities,
and truth states. Amend the external-integration operating model and non-goal so
they distinguish intentional capture from eligible ambient candidate creation
and still reject indiscriminate conversation ingestion or automatic belief.

Verification:

```text
node --test tests/secondbrain-external-integrations-doc-test.js
npm run test:structure
```

### Step 8 — Full review and verification

Run the complete suite, inspect the exact diff, verify forbidden paths and
imports, and confirm the branch has no upstream and no remote ref.

Verification:

```text
npm test
git diff --check af427a68bbe88c0f08dc516356e3fee55cf41b89..HEAD
git status --short --branch
git log --oneline af427a68bbe88c0f08dc516356e3fee55cf41b89..HEAD
```

## Failure modes

| Failure | Response |
| --- | --- |
| Baseline suite fails | Stop and report; do not absorb unrelated fixes |
| Existing owner or export convention differs | Follow the exact-base owner; do not create a new package |
| Open PR overlaps an implementation file | Drop or relocate the overlapping additive edit; do not rebase another PR |
| Validator accepts unknown version, enum, or field | Blocking defect; add or fix a rejecting test |
| Candidate schema can carry ineligible or authoritative state | Blocking defect; narrow the schema |
| Receipt implies successful mutation for a non-committed outcome | Blocking defect; enforce outcome/revision invariant |
| Receipt implies universal rollback | Blocking defect; clarify reversal mode and destination ownership |
| Fixture contains real/private information | Replace it before commit and inspect history |
| Implementation requires store, CLI, Doctor, runtime, or setup changes | Defer to the next slice |
| Full suite reveals an unrelated regression | Confirm base behavior; stop rather than broaden scope |

## Pull-request overlap strategy

The current relevant draft pull requests touch onboarding, Obsidian probes,
Codex rollback, runtime-kit, and root `package.json`. Read-only file inspection
found no overlap with the new contract source files. This plan deliberately
avoids root `package.json` to eliminate the known shared file.

Do not rebase or modify pull requests #249, #252, #253, #255, or #256. Before
final review, repeat their changed-file inspection. If new overlap appears,
keep this branch local and report the integration order rather than rewriting
the other branches.

## Commit boundaries

1. `docs: add product realization foundation plan`
2. `feat(control-plane): add portable identity contract`
3. `feat: add capability truth ledger contract`
4. `feat(ambient): add candidate envelope contract`
5. `feat(control-plane): add promotion receipt contract`
6. `test: add foundation contract conformance fixtures`
7. `docs: reconcile candidate and truth boundaries`
8. A correction commit only if review finds a defect; otherwise none.

## Review gates

1. The plan artifact is committed before implementation.
2. Opus implements only this plan and reports every divergence.
3. Codex reviews the exact diff against every field-level invariant and runs
   focused plus full tests.
4. A fresh independent model review examines the final local commit for
   contract errors, privacy leakage, scope expansion, and regressions.
5. Findings are fixed and the full suite is rerun before completion.
6. Push, pull request, merge, release, install, and activation remain separate
   user decisions.

## Deferred work

- full capability audit and automatic ledger reporter;
- Doctor, release, and CI consumption of the ledger;
- identity enrollment, persistence, recovery, and authority transfer;
- candidate store, expiry worker, review queue, policy engine, deduplication,
  conflict resolution, and redacted projections;
- source adapters that construct candidates;
- destination executors and destination-specific receipt embedding;
- correction, forgetting, and derived-layer rebuild implementation;
- session pointers and context stamps;
- onboarding, profile, runtime, OpenClaw, multi-machine, and Mini work; and
- all automatic promotion.

## No-production-mutation proof checklist

- [ ] Branch is based on the exact recorded `origin/main` commit.
- [ ] Branch has no upstream and no remote branch.
- [ ] No push or pull request was created.
- [ ] Diff touches only the listed contract, fixture, test, and documentation
  files.
- [ ] Root `package.json`, lockfile, bootstrap, CLI, Doctor, profiles, runtimes,
  templates, hooks, and setup paths are unchanged.
- [ ] No code imports network, scheduler, OS identity, environment-derived
  identity, Vault, Obsidian, GBrain, or Paperclip behavior.
- [ ] No fixture or document contains personal data, real absolute paths,
  secrets, transcript text, Vault content, or deployment evidence.
- [ ] Seed ledger says `draft`, `draft-pr`, `inactive`, `none`, `partial`, and
  `fixture-proven`.
- [ ] Candidates are structurally non-authoritative and immutable.
- [ ] Receipts distinguish attempts from successful mutation and do not promise
  rollback.
- [ ] Focused and full test suites pass.
- [ ] Git status is clean after local commits.
