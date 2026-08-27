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

The owner-side writer is intentionally small and generic:

```bash
node scripts/jarvos-gbrain-continuity-snapshot.js \
  --workspace /absolute/jarvos-workspace \
  --input /absolute/owner-only/continuity-snapshot.json
```

It accepts only an owner-only exact-schema input, creates owner-only state
directories, requires a strictly newer generation, and atomically replaces the
snapshot. It delegates validation to this existing health-module contract; it
does not add a registry, probe runner, or second validator.

The public name and module ID are intentionally separate from legacy private
identifiers such as `memory-stack-doctor`. Existing private schedules and
receipts may retain those identifiers through a compatibility migration, but
they must not appear in routine Doctor output or public JSON.

Documentation impact: module-docs. This generic contract is a public jarvOS
release candidate; producer-specific scheduling, runtime activation, delivery,
and repair adapters remain outside the public contract.
