---
name: session-wait
description: Register a bounded external result and return it once to the originating Codex session.
triggers:
  - wait for the result
  - return the result here
  - session-wait
metadata:
  jarvos:
    bundle: operating-system-skills
    portability: codex
    authority: clawd-session-wait-engine
---

# Session Wait

Use this skill when work must continue outside the current turn and its result
must come back to this exact Codex session. The skill is a front door to the
private clawd SessionWait engine; it is not a second worker, scheduler, or
notification channel.

## Contract

The workflow is complete only when:

- registration is made from a real Codex turn with trusted session and
  repository bindings
- the wait has one stable `waitId`, an allowlisted terminal producer, an
  explicit deadline, and a durable owner-only receipt
- a terminal receipt is authenticated against the bound wait, subject,
  revision, fence, and producer
- the result is presented at most once to this exact session, immediately only
  when the native Codex adapter proves the target and acknowledgement
- otherwise one bounded projection is queued for the originating session's
  next eligible hook; it is never rerouted to another session or channel
- missing, late, conflicting, cancelled, superseded, and uncertain outcomes
  remain explicit rather than being silently retried

## Allowed actions

The skill may request only these operations through the private engine:

- `register` — create or reuse one wait bound to the current Codex turn
- `inspect` — show a bounded, redacted status projection
- `cancel` — cancel the current wait when the originating owner requests it

The skill cannot grant itself event-ingest authority, choose a producer, change
the repository binding, extend a deadline, start a worker, run `codex exec`, or
send Telegram, calendar, email, or other external notifications.

## Safe result shape

Terminal producers return a typed outcome, an opaque result handle, a
`sha256:` result digest, and a small inert projection. Raw prompts,
transcripts, credentials, absolute paths, instructions, and arbitrary external
payloads do not belong in the wait or its public projection. A result-missing
receipt must remain missing; the system must not invent a result summary.

## Delivery semantics

The authoritative race is a single compare-and-set between an authenticated
terminal receipt and the deadline reader. The winner determines whether the
wait has a result or an explicit `expired_missing_result` outcome. Delivery is
separate from truth:

1. an immediate native delivery is marked delivered only with a durable
   acknowledgement for the bound thread
2. an unsupported or ambiguous immediate attempt becomes one
   `queued_next_hook` projection, with no retry loop
3. the next eligible hook claims and consumes that projection once
4. duplicate receipts, process restarts, and late events return the existing
   disposition rather than displaying twice

Preserve the active session's goal, sandbox, approval, and repository scope.
Do not use this skill to create a background keepalive, polling loop, calendar
reminder, or generic workflow engine.
