# Agentmemory Experience-Memory Adapter Contract

Status: design contract for jarVOS v0.6 dogfood.

This contract defines the narrow jarVOS-owned boundary for using agentmemory as a
local shared experience-memory sidecar. Hosts do not get direct access to
agentmemory. They call the jarVOS adapter, and the adapter decides what is safe
to write, what is advisory to read, and what must stay in the existing memory
stack.

## Placement

Agentmemory is an optional shared experience-memory sidecar. It is not the
brain, not durable truth, and not live project state.

| Layer | Owns |
| --- | --- |
| GBrain | Reviewed structured graph truth |
| QMD / native memory | Markdown, note, and transcript recall |
| lossless-claw / OpenClaw runtime memory | Conversation continuity and compaction recall |
| Paperclip | Issues, status, ownership, blockers, approvals, and review evidence |
| agentmemory via jarVOS adapter | Recent cross-personality experience: what another agent saw, tried, fixed, failed at, or learned |

## Write Schema

Adapter writes must be event-shaped observations. They must not be raw transcript
dumps, private-message mirrors, full tool payloads, or config snapshots.

Required top-level fields:

```json
{
  "schemaVersion": "0.1.0",
  "eventType": "observation",
  "summary": "Short plain-English observation.",
  "body": "Optional bounded detail with secrets and private content removed.",
  "promotionTags": [],
  "provenance": {
    "host": "codex",
    "personality": "michael",
    "agentId": "michael",
    "sessionId": "session-or-run-reference",
    "sourceRoute": "paperclip-heartbeat",
    "observedAt": "2026-06-04T00:00:00.000Z"
  }
}
```

Allowed `eventType` values:

- `observation`
- `attempted-fix`
- `local-decision`
- `failure`
- `test-result`
- `handoff`
- `lesson`
- `anti-repeat-note`

Required provenance fields:

- `host`
- `personality`
- `agentId`
- `sessionId`
- `sourceRoute`
- `observedAt`

Recommended provenance fields:

- `paperclipIssueId`
- `paperclipIssueIdentifier`
- `repo`
- `branch`
- `pullRequestUrl`
- `runId`
- `transcriptRef`
- `confidence`
- `sensitivityClass`
- `retentionClass`

Retention classes:

- `session` for short-lived context that should age out quickly.
- `issue` for context tied to one Paperclip issue or code branch.
- `release-dogfood` for v0.6 dogfood evidence.
- `archive-candidate` for observations that may justify an export or reviewed
  durable-memory promotion.

## Read Schema

Reads are advisory. A host may ask what another personality has already seen or
tried, but the result cannot update durable truth or task state by itself.

```json
{
  "query": "what did another personality already try for this issue?",
  "purpose": "issue-pickup",
  "requester": {
    "host": "codex",
    "personality": "michael",
    "agentId": "michael"
  },
  "scope": {
    "paperclipIssueIdentifier": "SUP-2276",
    "repo": "levineam/clawd",
    "branch": "SUP-2276/agentmemory-adapter-contract"
  },
  "limits": {
    "maxResults": 5,
    "maxTokens": 1200,
    "freshnessDays": 30
  }
}
```

Allowed read purposes:

- `session-start`
- `issue-pickup`
- `handoff`
- `avoid-repeat`
- `debug-failure`
- `dogfood-review`

Every read result returned to a host must include:

- source observation or memory identifier
- writer personality
- related Paperclip issue when available
- age / observed time
- confidence or degraded-status note
- a reminder that the result is advisory

## Allowed agentmemory Surface

The adapter may use only these agentmemory surfaces:

| Surface | Purpose |
| --- | --- |
| `GET /agentmemory/health` | Daemon presence and degraded-mode diagnostics |
| `GET /agentmemory/livez` | Runtime liveness diagnostics |
| `POST /agentmemory/session/start` | Start an adapter-scoped session and fetch advisory context |
| `POST /agentmemory/session/end` | Close an adapter-scoped session |
| `POST /agentmemory/observe` | Write low-risk shared experience observations |
| `POST /agentmemory/smart-search` | Retrieve advisory cross-personality experience hits |
| `POST /agentmemory/context` | Generate bounded advisory context for issue pickup, handoff, or session start |
| `GET /agentmemory/audit` | Doctor and review evidence only |
| `GET /agentmemory/export` | Portability, backup, and vendor-lock-in proof only |

The adapter must set personality provenance explicitly. Upstream agentmemory
supports `AGENT_ID` tagging and shared/isolated recall scope; jarVOS dogfood uses
shared scope only when each write carries the writer personality.

## Blocked Surface

These surfaces stay blocked until a later issue explicitly expands the contract:

- direct host access to `@agentmemory/mcp` tools
- `memory_save`, `memory_remember`, or `POST /agentmemory/remember` without
  adapter review
- `POST /agentmemory/import`
- `POST /agentmemory/forget` or governance deletion from ordinary hosts
- `POST /agentmemory/graph/query` as a GBrain or ontology source
- `POST /agentmemory/team/share`
- `POST /agentmemory/enrich` for automatic pre-tool context injection
- viewer or iii console exposure outside loopback
- memory slot mutation, reflection, or automatic `MEMORY.md` mirroring
- automatic hook capture before the jarVOS adapter allowlist exists

Doctor/export/privacy work may exercise blocked surfaces only as controlled
operator checks, not as host runtime capabilities.

## Promotion Tags

Promotion tags mark possible future review. They do not promote anything.

Allowed tags:

- `promote-fact-candidate`
- `promote-preference-candidate`
- `promote-decision-candidate`
- `promote-lesson-candidate`
- `promote-project-state-candidate`
- `promote-ontology-candidate`
- `paperclip-followup-candidate`

Nothing auto-promotes from agentmemory into GBrain, ontology, durable Memory,
Vault notes, AGENTS/rules, or Paperclip status. A tagged candidate must go
through the existing owner and review path for that destination.

## Fallback Behavior

The adapter must fail soft:

- If agentmemory is down, return `degraded: agentmemory-unavailable` and an empty
  advisory result set.
- If health is present but reads fail, return `degraded: recall-failed` and do
  not retry in a loop.
- If results are older than the requested freshness window, return them only with
  `degraded: stale-results` and an age marker.
- If writes fail, log/report the adapter failure and continue the host workflow.
- Agentmemory outages must not block Paperclip checkout, status updates, tests,
  PR review, GBrain recall, QMD recall, or durable memory promotion.

## v0.6 Dogfood Evidence

jarVOS v0.6 dogfood evidence must be captured per real cross-personality handoff:

```json
{
  "relatedPaperclipIssueIdentifier": "SUP-2276",
  "writerPersonality": "jarvis",
  "readerPersonality": "michael",
  "recallPurpose": "handoff",
  "usefulRecallHits": ["observation-id-1"],
  "missedContext": ["what should have been recalled but was not"],
  "badOrIntrusiveSuggestions": ["suggestion that was wrong, noisy, or unsafe"],
  "sourceObservationIds": ["observation-id-1"],
  "memoryHelped": true,
  "reviewNote": "Plain-English judgment of whether the recall changed the work."
}
```

Review gate for jarVOS v0.6:

- Evidence lane: jarVOS v0.6 shared experience memory dogfood release lane
  ([SUP-2290](/SUP/issues/SUP-2290)).
- Review after either 14 calendar days of dogfood or 10 real
  cross-personality handoffs, whichever comes first.
- The review must recommend exactly one outcome: `adopt`, `revise`, or `remove`.
- Broader inclusion is blocked until that recommendation is recorded.

## Source Notes

This contract was checked against upstream agentmemory documentation on
2026-06-04. The upstream surface currently documents REST on
`/agentmemory/*`, multi-agent `AGENT_ID` tagging, shared/isolated scope,
localhost defaults, and a larger MCP/tool surface. jarVOS intentionally allows a
smaller subset for dogfood.
