---
name: cron-hygiene
description: Validate, audit, and maintain scheduled agent automation without unsafe direct state edits.
triggers:
  - cron health
  - audit cron jobs
  - create a cron job
  - schedule a job
  - cron not firing
  - cron-hygiene
metadata:
  jarvos:
    bundle: operating-system-skills
    portability: generic
---

# Cron Hygiene

Use this skill before creating, editing, or diagnosing scheduled automation.

## Contract

The workflow is complete only when:

- new schedules are checked for duplicates, congestion, boundaries, and runtime
  cost before creation
- cron state is changed through the runtime's cron API or CLI, never by directly
  patching scheduler storage
- changed jobs are force-run or smoke-tested when possible
- run history and expected side effects are checked before success is claimed
- failures become explicit blockers or follow-up issues with an owner/action

## Pre-creation gate

Before adding a job:

1. **Duplicate check.** Does a similar job already exist?
2. **Frequency check.** Is the cadence proportional to the value of the job?
3. **Boundary check.** Avoid obvious contention slots such as exact hour or
   quarter-hour boundaries unless timing is essential.
4. **Congestion check.** Avoid creating several heavyweight jobs in the same
   small time window.
5. **Runtime cost check.** Use the cheapest model/tool surface that can do the
   job reliably.
6. **Target check.** Confirm referenced scripts or commands exist in the live
   runtime workspace.
7. **Smoke check plan.** Define how the first run and side effect will be proven.

## Diagnosis checklist

When a job fails or stalls:

- inspect recent run history before editing the schedule
- distinguish scheduler failure from script failure
- look for repeated timeouts near the configured timeout limit
- check whether the job depends on a moved file, missing environment variable,
  unavailable CLI, or stale working directory
- prefer a narrow fix plus one force-run over broad schedule churn

## Success proof

A cron job is not done because it exists. It is done when:

- the active definition points at live code
- one real run has completed or the runtime has accepted a scheduled next run
- the expected side effect appeared
- the verification result is recorded in the tracker or runbook
