# OKR-Linked Task Board (Reusable Template)

> **Portable template:** Every task must link to a KR. If no KR link exists, do not execute.
> Pair with `PROJECT-KICKOFF-PACK.template.md`.

## Board Rules (Quality + Flow)

1. **KR Link is mandatory** for all tasks (`KR1.1`, `KR2.1`, etc.).
2. **Definition of Ready** must be met before moving to `Ready`.
3. **Quality gates** must pass before moving to `Done`.
4. **Blocked tasks** need owner + unblock date + escalation note.

## Status Buckets & Quality Gates

| Status Bucket | Entry Criteria | Exit Criteria |
|---------------|----------------|---------------|
| Intake | Idea captured with clear problem statement | KR linked + priority assigned |
| Ready | Scope clear, dependencies known, owner assigned | Work started with implementation plan |
| In Progress | Actively being executed | PR/test artifact ready for review |
| In Review | Review in progress (peer/QA/stakeholder) | Feedback resolved + acceptance evidence attached |
| Blocked | Cannot progress due to dependency/decision/incident | Unblock action completed + new ETA recorded |
| Done | Acceptance criteria met | KR impact logged + release/closeout notes attached |

---

## Intake

| Task ID | Linked KR | Task (Outcome-Oriented) | Priority | Owner | Notes |
|--------|-----------|--------------------------|----------|-------|-------|
| T-001  | KR1.1     |                          |          |       |       |

## Ready

| Task ID | Linked KR | Task | Owner | Est. Effort | Definition of Ready Check |
|--------|-----------|------|-------|-------------|---------------------------|
| T-010  | KR1.2     |      |       |             | [ ] scope [ ] deps [ ] test plan |

## In Progress

| Task ID | Linked KR | Task | Owner | Start Date | Current Risk | Next Checkpoint |
|--------|-----------|------|-------|------------|--------------|-----------------|
| T-020  | KR1.1     |      |       |            |              |                 |

## In Review

| Task ID | Linked KR | Task | Reviewer | Evidence Link (PR/Test/Demo) | Review Outcome |
|--------|-----------|------|----------|-------------------------------|----------------|
| T-030  | KR2.1     |      |          |                               |                |

## Blocked

| Task ID | Linked KR | Blocker | Owner | Since | Unblock Plan | Escalate By |
|--------|-----------|---------|-------|-------|--------------|-------------|
| T-040  | KR1.3     |         |       |       |              |             |

## Done

| Task ID | Linked KR | Task | Completion Date | Acceptance Evidence | KR Delta |
|--------|-----------|------|-----------------|---------------------|----------|
| T-099  | KR1.1     |      |                 |                     |          |

---

## Task-Level Quality Gate Checklist (Before Done)

- [ ] Linked KR is explicit and still valid
- [ ] Acceptance criteria met and evidenced
- [ ] Tests/checks relevant to change are passing
- [ ] Documentation/runbook updated if behavior changed
- [ ] Risk/security/privacy considerations reviewed
- [ ] Owner confirms outcome delivered (not just activity completed)

## KR Progress Snapshot

| KR ID | Current Value | Target | Trend | Notes |
|------|----------------|--------|-------|-------|
| KR1.1 |                |        |       |       |
| KR1.2 |                |        |       |       |
| KR1.3 |                |        |       |       |

## Weekly Execution Review

- **What moved KRs this week?**
- **What stayed active but had low KR impact?**
- **What should be de-scoped, merged, or escalated?**
- **What is next week’s highest-leverage autonomous work?**

---

**Reusable Template Marker:** `okr-task-board-standard-v1`
