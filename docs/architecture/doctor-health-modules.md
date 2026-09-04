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
remains supported when no v2 Memory roster is present. Once that roster is
present, it is authoritative; the aggregate is neither rendered nor part of
the eleven-component result.

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
