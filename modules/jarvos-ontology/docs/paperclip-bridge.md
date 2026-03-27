# Paperclip Bridge — Implementation

**SUP-97 deliverable** | Implemented 2026-03-20

## Summary

The Paperclip bridge syncs ontology Goals and Projects to Paperclip entities.

- **Direction:** Ontology → Paperclip (ontology is meaning source of truth)
- **Trigger:** `node scripts/sync-to-paperclip.js` (batch, run manually or via cron)
- **Mapping:** Goals → Paperclip Goals, Projects → Paperclip Projects (goal linkage only)

## Architecture

```
ontology/5-goals.md ──┐
                      ├──→ src/bridge.js ──→ Paperclip Goals API
ontology/6-projects.md┘       │
                              ├──→ bridge-state.json (ID mapping, gitignored)
                              └──→ Paperclip Projects API (goal linkage only)
```

## What Gets Synced

| Ontology concept | Paperclip entity | Mapping behavior |
|-----------------|-----------------|-----------------|
| Goal (G1, G2…) | Goal (level: "team") | Create/update title, status. Parent = company goal. |
| Project (PJ1…) | Project (existing only) | Update goal linkage from `serves` links. Projects are NOT created from ontology. |
| Core Self Mission | Company Goal | Not synced — manually established once. |
| Beliefs, Predictions | *Not mapped* | Meaning layer only. |

## Status Mapping

| Ontology Status | Paperclip Goal Status | Paperclip Project Status |
|----------------|----------------------|------------------------|
| Active | active | in_progress |
| Achieved | achieved | done |
| Cancelled | cancelled | cancelled |
| Stopped | paused | paused |
| Someday/Long-term | planned | backlog |
| Ongoing | active | in_progress |

## ID Mapping

`bridge-state.json` (gitignored, machine-local) tracks ontology IDs → Paperclip UUIDs:

```json
{
  "goalMap": { "G1": "d4c462ab-...", "G2": "eb0b89f0-..." },
  "projectMap": { "PJ2": "0327651a-..." },
  "lastSyncAt": "2026-03-20T21:44:58.470Z",
  "syncLog": [...]
}
```

## Failure Modes

| Scenario | Behavior |
|----------|----------|
| Goal in ontology, not in Paperclip | Created in Paperclip |
| Goal in Paperclip, not in ontology | Left alone (execution-only goal) |
| Mapped goal UUID deleted from Paperclip | Error reported — stale mapping requires manual fix |
| Unmapped goal with matching title | Adopted (existing UUID stored in mapping) |
| Project in ontology, no name match | Skipped (projects are execution entities) |
| Project serves goals not yet mapped | Goal linkage skipped until goals are mapped |
| Duplicate goal titles | First match wins on adoption; subsequent are created fresh |
| Network error during sync | Error logged, state not updated for that item |

## Conflict Resolution

- **Ontology wins:** title, status, goal linkage (why things exist)
- **Paperclip wins:** execution state, issue counts, agent assignment
- Bridge never deletes Paperclip entities — only creates/updates

## Usage

```bash
# Set required environment variables:
#   export PAPERCLIP_API_URL=http://127.0.0.1:3100
#   export PAPERCLIP_API_KEY=pcp_...
#   export PAPERCLIP_COMPANY_ID=<uuid>

# Dry run (see what would change)
node scripts/sync-to-paperclip.js --dry-run --verbose

# Live sync
node scripts/sync-to-paperclip.js

# With npm scripts
npm run sync:dry
npm run sync
```

## Interfaces

```javascript
import { syncOntologyToPaperclip, loadBridgeState } from '@claw/ontology/bridge';

const result = await syncOntologyToPaperclip({
  ontologyDir: '/path/to/ontology',
  stateDir: '/path/to/state',
  paperclipUrl: 'http://127.0.0.1:3100',
  paperclipApiKey: 'pcp_...',
  companyId: 'uuid',
  companyGoalId: 'uuid',    // optional parent for new goals
  dryRun: false,             // true = plan only
});

// result.goals — per-goal actions taken
// result.projects — per-project actions taken
// result.state — final bridge-state snapshot
// result.syncEvent — summary with counts + errors
```

## Design Decisions

1. **Projects are not created from ontology.** Ontology defines *why* a project exists (meaning); Paperclip creates projects as *execution* entities. The bridge only syncs goal linkage.

2. **Goal creation uses team level.** All ontology goals map to Paperclip team-level goals, parented under the company goal. This matches the contract in `jarvos-ontology-migration-contract.md`.

3. **Title-based adoption.** When a bridge-state.json mapping is missing but a Paperclip goal exists with the same title, we adopt it rather than creating a duplicate. This makes first-run seeding safe.

4. **Stale mapping = error, not auto-fix.** If a mapped Paperclip goal is deleted, we report an error rather than silently creating a new one. This prevents "shadow duplication" and requires intentional manual resolution.

5. **Sync log for auditability.** Each sync appends a summary event to `bridge-state.json.syncLog` (last 50 kept). This makes it easy to trace when goals were created/updated without digging through git.
