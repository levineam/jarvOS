# jarvos-agentify: Activity Log — Schema & API Reference

**Version:** `jarvos-agentify/activity-log/v1`
**Release:** jarvos-agentify v0.5.0
**Status:** Foundational seam — must be stable before children 2–9 can proceed.

---

## Overview

The activity log is the **central seam** between the two halves of jarvos-agentify:

- **Agentification half** (loops, sessions, plans, actions) → **writes** events
- **Content half** (skeleton generation, publishing pipeline) → **reads** events

It is:
- **Append-only** — events are never modified or deleted
- **Per-tenant** — every event carries `tenant_id`; tenants are fully isolated
- **Typed** — every event must match a registered type from the taxonomy
- **Watermark-based** — consumers track position via the `seq` field

---

## Event Record Shape

Every persisted event has the following fields:

```json
{
  "schema":      "jarvos-agentify/activity-log/v1",
  "id":          "a3f7c1d2e8b4...",
  "seq":         42,
  "tenant_id":   "aaf",
  "type":        "agent.loop.started",
  "occurred_at": "2026-05-29T10:00:00.000Z",
  "recorded_at": "2026-05-29T10:00:00.012Z",
  "source":      "jarvos-agentify",
  "payload":     { "loop_id": "loop-001", "trigger": "cron" }
}
```

| Field         | Type     | Required | Description |
|---------------|----------|----------|-------------|
| `schema`      | string   | yes      | Schema version string |
| `id`          | string   | yes      | Unique event ID (hex, 16 chars) |
| `seq`         | number   | yes      | Monotonically increasing integer per tenant; the watermark cursor |
| `tenant_id`   | string   | yes      | Tenant namespace (e.g. `"aaf"`, `"jarvos"`) |
| `type`        | string   | yes      | Event type from the taxonomy (see below) |
| `occurred_at` | ISO 8601 | yes      | When the event happened (caller-provided) |
| `recorded_at` | ISO 8601 | yes      | When the event was written to the log |
| `source`      | string   | yes      | System or agent that wrote the event |
| `payload`     | object   | no       | Event-specific data (type-defined shape) |

---

## Event Taxonomy

### `agent.*` — Agent lifecycle

| Type | Description | Payload fields |
|------|-------------|----------------|
| `agent.loop.started` | Daily agent loop began | `loop_id`, `trigger` |
| `agent.loop.completed` | Daily agent loop finished | `loop_id`, `duration_ms`, `outcome` |
| `agent.loop.failed` | Daily agent loop failed or was interrupted | `loop_id`, `error`, `duration_ms` |

### `session.*` — Agent-session object

| Type | Description | Payload fields |
|------|-------------|----------------|
| `session.started` | Agent session started | `session_id`, `channel_id`, `trigger` |
| `session.ended` | Agent session ended | `session_id`, `duration_ms`, `outcome` |
| `session.paused` | Session paused, awaiting human input | `session_id`, `reason` |
| `session.resumed` | Session resumed after human input | `session_id`, `resumed_by` |

### `plan.*` — Proposed/approved/rejected plans

| Type | Description | Payload fields |
|------|-------------|----------------|
| `plan.proposed` | Plan proposed; awaiting approval | `plan_id`, `summary`, `items`, `proposed_by` |
| `plan.approved` | Plan was approved | `plan_id`, `approved_by` |
| `plan.rejected` | Plan was rejected | `plan_id`, `rejected_by`, `reason` |
| `plan.revised` | Plan revised before approval | `plan_id`, `revised_by`, `changes` |

### `action.*` — Bounded actions

| Type | Description | Payload fields |
|------|-------------|----------------|
| `action.taken` | A bounded action was executed (hardening-only on silence) | `action_id`, `kind`, `description`, `result`, `hardening_only` |
| `action.proposed` | Action proposed, pending approval | `action_id`, `kind`, `description` |
| `action.reverted` | Action was reverted (metric gate or manual) | `action_id`, `reason` |

### `metric.*` — Self-improvement gate

| Type | Description | Payload fields |
|------|-------------|----------------|
| `metric.measured` | A metric value was recorded | `metric_name`, `value`, `unit`, `context` |
| `metric.gate.passed` | Gate: metric held/improved — action kept | `action_id`, `metric_name`, `before`, `after` |
| `metric.gate.failed` | Gate: metric degraded — action reverted | `action_id`, `metric_name`, `before`, `after` |

### `content.*` — Content-as-exhaust pipeline

| Type | Description | Payload fields |
|------|-------------|----------------|
| `content.skeleton.emitted` | Publishable content skeleton generated | `skeleton_id`, `source_events`, `verbatim_count` |
| `content.voice_pass.requested` | Human voice pass requested | `skeleton_id`, `reviewer` |
| `content.attested` | Human attested the skeleton for publication | `skeleton_id`, `attested_by` |
| `content.published` | Content published after attestation | `skeleton_id`, `channel`, `url` |

### `channel.*` — Channel context

| Type | Description | Payload fields |
|------|-------------|----------------|
| `channel.context.fetched` | Channel messages/context fetched as agent input | `channel_id`, `message_count`, `time_range` |

### `system.*` — Internal/admin

| Type | Description | Payload fields |
|------|-------------|----------------|
| `system.tenant.registered` | New tenant registered | `tenant_id`, `config` |
| `system.checkpoint` | Periodic health checkpoint | `status`, `message` |

---

## API

### `createActivityLog(opts?)`

Create a log API bound to a store directory.

```js
const { createActivityLog } = require('@jarvos/agentify');

const log = createActivityLog({
  storeDir: '/path/to/store',  // optional; defaults to $JARVOS_AGENTIFY_STORE_DIR or ~/.jarvos/agentify/activity-log
});
```

### `log.write(tenantId, type, payload?, opts?)`

Append a typed event for a tenant.

```js
const { event, error } = log.write('aaf', 'agent.loop.started', {
  loop_id: 'loop-001',
  trigger: 'cron',
}, {
  source:      'my-agent',           // optional; defaults to 'jarvos-agentify'
  occurredAt:  '2026-05-29T10:00Z', // optional; defaults to now
});
```

Returns `{ event, error }`. `event` is the full persisted record with `seq`, `id`, `schema`, etc.

### `log.read(tenantId, opts?)`

Read events for a tenant, optionally from a watermark.

```js
const { events, cursor, error } = log.read('aaf', {
  after: 0,              // return events with seq > after (default 0)
  limit: 100,            // max events to return (default 1000)
  types: ['plan.*'],     // filter by exact types or wildcard groups like plan.*
});
```

Returns `{ events, cursor, error }`. `cursor` is the `seq` of the last returned event.

### `log.watermark(tenantId)`

Return the current highest `seq` for a tenant.

```js
const { seq, error } = log.watermark('aaf');
// seq=0 if no events have been written
```

### `log.subscribe(tenantId, callback, opts?)`

Subscribe to new events via polling.

```js
const sub = log.subscribe('aaf', (events) => {
  for (const event of events) {
    console.log(event.type, event.payload);
  }
}, {
  pollIntervalMs: 5000,  // poll frequency in ms (default 5000)
  after: 0,              // start from this watermark (default: current watermark)
});

// Later:
sub.stop();

// Current cursor position:
console.log(sub.cursor);
```

The returned `Subscription` is an `EventEmitter` that emits:
- `'events'` — array of new events
- `'error'` — Error on read failure

---

## Storage

The default adapter is **JSONL** (JSON Lines) — one file per tenant, append-only:

```
{storeDir}/
  {tenantId}/
    activity.jsonl   ← one JSON event per line, never modified
    meta.json        ← { "seq": N } — current watermark
```

The `seq` is incremented atomically before each append. A corrupt or missing `meta.json` falls back to `seq=0`; corrupt JSONL lines are silently skipped on read.

This adapter has zero external dependencies. A future adapter can implement the same `appendEvent`/`readEvents`/`getWatermark` interface over SQLite or Postgres.

---

## Multi-tenant isolation

Each tenant's events are stored in a separate subdirectory and sequence counter. Tenants never see each other's events through the read API.

```js
log.write('aaf',    'agent.loop.started', { loop_id: 'a' });
log.write('jarvos', 'system.checkpoint',  { status: 'ok' });

log.watermark('aaf').seq    // → 1
log.watermark('jarvos').seq // → 1  (independent counter)
```

---

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `JARVOS_AGENTIFY_STORE_DIR` | `~/.jarvos/agentify` | Root directory for all activity log data |
