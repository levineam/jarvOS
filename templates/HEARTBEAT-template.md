<!-- jarvOS HEARTBEAT Template v2.0.0 | Runtime-neutral and authority-gated -->

# HEARTBEAT.md — Optional Check-In

This file is inert until a runtime provides heartbeat capability and the user
explicitly authorizes its scope. If either is absent, do not run a background
check or create a schedule.

## Before any check

1. Confirm the active runtime can perform the requested check.
2. Confirm the user has authorized this check, its cadence, and every surface
   it may read or change.
3. Keep the check read-only by default. Queue a proposal for any durable
   workspace, notes-store, task-board, calendar, messaging, or external-service
   change.

## Safe default behavior

- Resume or report only work already authorized by the user.
- Never send external messages or create recurring schedules without explicit
  approval.
- Never create, repair, normalize, or update journal, notes, memory, or task
  artifacts unless the user has granted authority for that named surface.
- Never run provider update checks or resident-harness commands unless that
  runtime has been selected and the user has opted in to the check.
- When there is nothing authorized to do, return the runtime's quiet response
  (or remain silent if it has none).

## Proposal format

For a new automation or persistent change, ask for approval with: capability,
runtime, cadence (if recurring), exact targets, intended mutation, and how to
stop or reverse it. Record no approval by implication.

---

*A heartbeat is an opt-in capability, not an installation default.*
