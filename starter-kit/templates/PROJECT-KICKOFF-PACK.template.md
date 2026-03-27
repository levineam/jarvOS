# Project Kickoff Pack (Reusable Template)

> **Portable template:** Copy this file into any new project to enforce **kickoff-before-build** and OKR-first execution.
> **Rule:** No implementation starts until this pack is completed and linked to an active task board.

## 0) Kickoff Gate (Required Before Build)

- [ ] Project name, owner, and timeline are defined
- [ ] At least 1 Objective + measurable KRs are defined
- [ ] Milestones are mapped to KR impact
- [ ] Acceptance criteria and Definition of Done are explicit
- [ ] Autonomous lane and escalation boundaries are explicit
- [ ] Unblock conditions are documented
- [ ] Reporting cadence is set
- [ ] Task board is created from `OKR-TASK-BOARD.template.md`

---

## 1) Project Metadata

- **Project Name:**
- **Owner / DRI:**
- **Contributors:**
- **Start Date:**
- **Target End Date:**
- **Status:** Planned / Active / Paused / Done
- **Related Links:**
  - Kickoff Doc:
  - Task Board:
  - Spec/PRD:
  - Repo:

## 2) Objective & Key Results (OKRs)

### Objective O1

> Outcome statement (what changes for users/business)

| KR ID | Key Result (measurable) | Baseline | Target | Target Date | Data Source | Owner |
|------|---------------------------|----------|--------|-------------|-------------|-------|
| KR1.1 |                           |          |        |             |             |       |
| KR1.2 |                           |          |        |             |             |       |
| KR1.3 |                           |          |        |             |             |       |

### Objective O2 (optional)

| KR ID | Key Result (measurable) | Baseline | Target | Target Date | Data Source | Owner |
|------|---------------------------|----------|--------|-------------|-------------|-------|
| KR2.1 |                           |          |        |             |             |       |

## 3) Milestones (Mapped to KRs)

| Milestone | Target Date | KR(s) Supported | Deliverable | Exit Criteria |
|-----------|-------------|-----------------|-------------|---------------|
| M1        |             |                 |             |               |
| M2        |             |                 |             |               |
| M3        |             |                 |             |               |

## 4) Scope Contract

### In Scope
- 

### Out of Scope (Now)
- 

### Assumptions
- 

### Dependencies
- 

## 5) Acceptance Criteria + Definition of Done

### Functional Acceptance Criteria
- [ ]
- [ ]

### Quality / Reliability Criteria
- [ ] Tests defined and passing
- [ ] Monitoring/observability adequate for release
- [ ] Rollback/fallback path documented

### Operational / Handoff Criteria
- [ ] Runbook or usage notes updated
- [ ] Owners for post-launch checks assigned

## 6) Autonomous Execution Lane

### Work Allowed Without Additional Approval
- Low-risk implementation tasks tied to existing KR-linked backlog items
- Documentation updates aligned to accepted scope
- Test and CI hardening that does not change product behavior

### Work Requiring Explicit Approval
- Scope expansion beyond this kickoff
- New external dependencies or vendor spend
- Security/privacy-impacting changes
- Deadline shifts affecting milestone commitments

## 7) Unblock Conditions (Escalation Rules)

Escalate immediately when any of these occur:
- Blocked > **24 hours** on any KR-critical task
- Missing decision from owner > **1 business day**
- Dependency slippage threatens milestone date
- Quality gate failure repeats twice without root-cause closure

Escalation payload should include:
1. What is blocked
2. Impacted KR(s)
3. Options considered
4. Recommended path + decision needed

## 8) Reporting Cadence

- **Daily (async):** KR movement, completed tasks, current blockers, next actions
- **Weekly review:** milestone health, KR trajectory, risks, scope decisions
- **Milestone closeout:** acceptance evidence + lessons learned

Use this compact status format:
- **Progress:**
- **KR Impact:**
- **Risks/Blockers:**
- **Decisions Needed:**
- **Next 24h / Next 7d:**

## 9) Kickoff Approval

- **Kickoff Date:**
- **Approved By:**
- **Approval Notes / Constraints:**

---

**Reusable Template Marker:** `kickoff-pack-standard-v1`
