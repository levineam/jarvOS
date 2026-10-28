# jarvOS Doctor health modules

`jarvos doctor` is the user-facing health surface. Optional health producers
publish data-only snapshots; jarvOS reads those snapshots and owns the public
four-state reduction:

- `healthy`
- `update available`
- `repair needed`
- `needs your attention`

The first public module is **Memory**, whose stable JSON module ID is `memory`.
The public module snapshot is read from `.jarvos/health-modules/memory.json` in
the user workspace. The file contains no executable code, commands, host paths,
work-order IDs, receipts, or private diagnostics. Missing optional module files
are omitted from the report rather than treated as failures.

The closed module allowlist also contains `gbrain-continuity`. Portable jarvOS
keeps this external provider optional. A private config opts into the continuity
contract with `gbrainContinuity.required: true`; in that mode a missing snapshot
is itself visible as `needs your attention` for Codex, Hermes, and OpenClaw.
Neither mode treats an installed GBrain binary as connectivity evidence.

The snapshot contract is versioned and contains only normalized facts:

```json
{
  "schema": "jarvos-health-module-snapshot/v1",
  "moduleId": "memory",
  "generation": 7,
  "observedAt": "2026-08-12T23:00:00.000Z",
  "validUntil": "2026-08-13T23:00:00.000Z",
  "trust": "trusted",
  "repairable": false,
  "updateAvailable": true
}
```

jarvOS validates ownership, owner-only permissions, path containment, schema,
freshness, generation, and the allowed field set before reducing the facts. A
stale, malformed, symlinked, untrusted, or otherwise unsafe snapshot becomes
`needs your attention` without exposing the rejected path or value.

An optional producer writes this public-safe snapshot after its authoritative
evaluation. It may retain detailed component diagnostics and repair evidence
privately. The public Doctor module never loads producer code or invokes a
repair operation.

The continuity snapshot uses the same loader, ownership checks, schema version,
and public four-state reducer. Its exact facts block carries only ordered target
states, generations, freshness, and SHA-256 identity tuples. A target reaches
`live-turn-proven` only when a current, consumed native-turn receipt matches the
same jarvOS runtime, GBrain runtime, logical brain, store, fixture, challenge,
producer, target, and probe generation. Codex must also prove resolver-backed
Skillify discovery. URLs, paths, credentials, queries, recalled facts, and skill
contents are not accepted snapshot fields.

The owner-side producer is target-generic but evidence-specific:

```bash
node scripts/jarvos-gbrain-continuity-snapshot.js \
  --workspace /absolute/jarvos-workspace \
  --descriptor /absolute/owner-only/gbrain-runtime.json \
  --input /absolute/owner-only/continuity-producer-input.json
```

The exact producer input names three ordered native probe commands and carries
no final facts block or trust flag. The producer revalidates the pinned GBrain
descriptor, creates a fresh challenge, invokes every command without a shell or
ambient database routing, validates its tuple-bound result, and constructs the
snapshot itself. Arbitrary snapshot JSON cannot claim live proof. An owner-only
lock serializes the generation check and atomic replacement; the existing
health-module validator remains the sole snapshot validator.

The public name and module ID are intentionally separate from legacy private
identifiers such as `memory-stack-doctor`. Existing private schedules and
receipts may retain those identifiers through a compatibility migration, but
they must not appear in routine Doctor output or public JSON.

## System Doctor receipt

Every `jarvos doctor` profile also projects its core checks and selected
optional components into `systemDoctor`, a backward-compatible
`jarvos-system-doctor-report/v1` receipt. The text view is a compact scoreboard:
one icon and one line per component, with short section labels only when the
receipt contains more than one section. Degraded rows include a concise reason
and next action; the structured reason code remains available in JSON.
Existing top-level JSON fields remain available to older consumers.

A clean profile has no selected optional components unless an owner-side
producer publishes `.jarvos/health-modules/system.json`. The snapshot binds its
facts to one profile, so a receipt for `local-openclaw` cannot silently color a
`minimal` run green. Its component list is the selection: absent GBrain,
SearXNG, Paperclip, OpenClaw, Telegram, or another provider has no effect when
the component was not selected. A selected component is always listed as one
of `healthy`, `warning`, `repair needed`, or `not configured`.

```json
{
  "schema": "jarvos-health-module-snapshot/v1",
  "moduleId": "system",
  "generation": 12,
  "observedAt": "2026-09-03T18:00:00.000Z",
  "validUntil": "2026-09-04T18:00:00.000Z",
  "trust": "trusted",
  "factsVersion": "jarvos-system-doctor-facts/v2",
  "facts": {
    "profile": "minimal",
    "components": [
      {
        "id": "provider.searxng",
        "state": "healthy",
        "reasonClass": "none",
        "evidence": {
          "httpReachable": true,
          "searchResultCount": 3,
          "runtimeToolAvailable": true
        }
      }
    ]
  }
}
```

SearXNG is deliberately stricter than a port check. A healthy claim requires
an HTTP response, at least one result from a real search, and availability of
the selected runtime's local-search tool. If the service responds while a real
search returns zero results or the runtime tool is absent, jarvOS downgrades
the component to `warning`.

When the system snapshot selects Memory, it must contain the existing eleven
components in their fixed order: GBrain core, GBrain semantic coverage,
Lossless Claw, QMD search,
memory-wiki, Notes & provenance, Recall evaluation, Scheduled maintenance,
Reviewed runtime, Automatic repair, and Telegram follow-up & proof. Partial or
reordered Memory rosters fail closed. The eleven-row roster is versioned as
`jarvos-system-doctor-facts/v2`; v1 snapshots fail closed rather than being
mistaken for complete coverage. The legacy aggregate `memory.json` contract
remains supported when no v2 or v3 Memory roster is present. Once that roster is
present, it is authoritative; the aggregate is neither rendered nor part of
the eleven-component result.

### Per-component check freshness (v3)

`jarvos-system-doctor-facts/v3` carries the same profile and component roster
as v2, plus a per-component `observedAt`/`validUntil` pair naming when that
one component was actually checked and when that check itself expires. The
pair is either both `null`, meaning the check age is unknown, or both valid
ISO timestamps with `validUntil` strictly after `observedAt` and `observedAt`
not after the reader's clock; missing, half-present, malformed, future, or
reversed values fail the whole snapshot closed. A v2 component never carries
these fields — reading it always reports an explicit `observedAt: null,
validUntil: null` rather than inheriting the aggregate publication time.

jarvOS evaluates a known v3 component's own deadline at read time against the
same injected clock used for the outer module, independently of the outer
snapshot's freshness. A component whose `validUntil` has passed is stale: its
reduced state is forced to `warning` with `reasonClass: "component-stale"`
even if the underlying report claimed `healthy` or `repair needed`, and even
when the System module that carries it was itself published moments ago. Its
own `observedAt`/`validUntil` are preserved through the module reduction and
into the public `systemDoctor` receipt (`components[].observedAt` /
`components[].validUntil`), with the v2 unknown age still reported as an
explicit `null`/`null` rather than the outer receipt's own dates. The receipt
also carries the selected system module's declared `factsVersion` (e.g.
`jarvos-system-doctor-facts/v3`) when one was supplied by a validated module,
and `null` otherwise; jarvOS never stamps or infers a version. This is a
component-level check only; the outer module's own trust and freshness gate is
unchanged and still governs the module as a whole before any component is
reduced.

### Product rows with sub-checks (v4)

`jarvos-system-doctor-facts/v4` regroups the flat component list into product
rows, each carrying its own sub-checks, plus a jarvOS Doctor status block.
v2 and v3 snapshots are read exactly as before; v4 is an addition, not a
migration, and a v4 version string never accepts a v2 or v3 shape.

```json
{
  "factsVersion": "jarvos-system-doctor-facts/v4",
  "facts": {
    "profile": "minimal",
    "products": [
      {
        "id": "capture",
        "label": "Capture",
        "maker": "jarvOS",
        "order": 1,
        "state": "healthy",
        "reasonClass": "none",
        "observedAt": "2026-09-03T17:55:00.000Z",
        "validUntil": "2026-09-03T18:10:00.000Z",
        "version": {
          "installedVersion": "0.11.0",
          "latestVersion": "0.12.0",
          "versionSource": { "installed": "package.json", "latest": "github-release" },
          "latestCheckedAt": "2026-09-03T17:00:00.000Z"
        },
        "checks": [
          {
            "id": "capture-ideas",
            "label": "Ideas",
            "state": "healthy",
            "reasonClass": "none",
            "observedAt": "2026-09-03T17:55:00.000Z",
            "validUntil": "2026-09-03T18:15:00.000Z",
            "evidence": null
          }
        ]
      }
    ],
    "doctor": {
      "label": "jarvOS Doctor",
      "state": "healthy",
      "reasonClass": "none",
      "observedAt": "2026-09-03T17:58:00.000Z",
      "validUntil": "2026-09-03T18:20:00.000Z",
      "checks": [
        {
          "id": "doctor-last-run",
          "part": "last-run",
          "label": "Last run",
          "state": "healthy",
          "reasonClass": "none",
          "observedAt": "2026-09-03T17:58:00.000Z",
          "validUntil": "2026-09-03T18:20:00.000Z"
        }
      ]
    }
  }
}
```

Grouping never loosens the green rule. A row reads green only when every one of
its checks is healthy and dated, and every check's own deadline is still in the
future. The reader rejects the whole snapshot (`module-invalid`) unless all of
the following hold:

- A product's or the Doctor's `state` equals the worst of its checks, ranked
  `repair needed` > `warning` > `not configured` > `healthy`. Its `reasonClass`
  is `none` when healthy and otherwise the reason of the first check at that
  worst state.
- The row's `observedAt` equals the oldest check `observedAt`, and its
  `validUntil` equals the earliest check `validUntil`. A row cannot be newer or
  longer-lived than its weakest check. Checks without dates are skipped; a row
  with no dated check at all reports `null`/`null`.
- Every healthy check carries both timestamps. An unknown check age (v3's
  `null`/`null`) is allowed only on a check that is not healthy.
- Check timestamps follow the v3 rules: a pair of both `null` or both valid ISO
  timestamps, `validUntil` strictly after `observedAt`, `observedAt` not after
  the reader's clock.
- Product and check ids are safe public ids and unique across the whole
  snapshot, including the Doctor's checks; `doctor` is reserved. Products are
  strictly ascending by `order` (a non-negative integer). There are at most 32
  products.
- Each product and the Doctor carry 1 to 8 checks. The list is open-ended, so a
  producer can add checks (for example `ideas` and `journal` under `capture`)
  without a version bump.
- The Doctor carries exactly four checks, one for each `part`: `last-run`,
  `reviewed-release`, `repairs`, and `alerts`.
- Labels and `maker` come from the snapshot and are non-empty single-line text
  of at most 80 characters. v4 has no built-in label tables.
- A check `evidence` is `null` or the SearXNG proof shape. A check with
  id `provider.searxng` must carry it, and a healthy check whose proof shows no
  HTTP response, no search result, or no runtime tool is downgraded to
  `warning` as in v2 and v3.

The `version` block is display-only and optional. It never affects a state,
`observedAt`, `validUntil`, or whether the snapshot is accepted. A block that
is absent, null, or malformed in any way (unknown field, wrong type, control
characters, bad timestamp) reads as `version: null`; jarvOS drops it instead of
rejecting the snapshot, so an unreliable version lookup cannot hide a real
health result.

Freshness is recomputed at read time, per check, against the same clock as v3.
A healthy check whose own `validUntil` has passed (the deadline itself counts
as passed) becomes `warning` with `reasonClass: "component-stale"`; an expired
failure keeps its severity and reason. The product row and the Doctor block are
then re-aggregated from the reduced checks, so one stale check turns its whole
row yellow even when the outer module was published moments ago. The outer
module gates (trust, freshness, profile binding) are unchanged and still apply
first. The module is `repair needed` when any row is, and `needs your attention`
when any product or the Doctor is not healthy.

The `jarvos-system-doctor-report/v1` receipt keeps its schema. It gains two
additive fields, `products` (the reduced product rows, `[]` for v2 and v3) and
`doctor` (the reduced Doctor block, `null` for v2 and v3), and its `components`
list carries one rollup row per product and one for the Doctor (marked with
`rollup`) so status and gating need no v4 knowledge. `jarvos doctor` prints a
Products section with each product's installed version, its sub-checks, and the
Doctor block beneath it.

A rejected module snapshot — `module-invalid`, `module-stale`, or
`module-untrusted` — is evidence the reader could not trust, not a service
claiming a fault. The `systemDoctor` receipt lists it as `warning` with its
specific reason class, never as `repair needed`.

## Consumer and ownership boundary

The receipt has three intended consumers:

1. `jarvos doctor` is the authoritative JSON and human-readable surface.
2. A configurable owner-side notification adapter may deliver exceptions only;
   it must not probe, repair, schedule, or reinterpret a healthy receipt.
3. jarvOS Desktop may render the same receipt after this public contract is
   stable; Desktop implementation belongs in its own repository and task.

The private owner remains responsible for machine-specific probes, credentials,
Telegram identities, launchd bindings, repair procedures, scheduling, and
publishing the normalized snapshot. The existing Memory Doctor Telegram
message remains unchanged until the new projection is behaviorally proven to
retain all eleven rows and at least the same operator information.

Documentation impact: module-docs. This producer contract is a public jarvOS
release candidate; private command declarations, scheduling, runtime
activation, delivery, and repair policy remain outside the public contract.
