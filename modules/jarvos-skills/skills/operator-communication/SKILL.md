---
name: operator-communication
description: Write plain-English operator messages that state what happened, what jarvOS did, whether action is required, and what happens next without leaking private diagnostics.
triggers:
  - operator notification
  - plain English alert
  - user-facing error message
  - blocked state message
  - recovery notification
metadata:
  jarvos:
    bundle: operating-system-skills
    portability: generic
    class: full
---

# Operator Communication

Use this skill whenever you write or review a user-facing operator message:
failure, warning, blocked work, recovery, completion, or release-status text.

This skill is guidance. Runtime enforcement lives in the public notification
contract and the outbound-message lint. Do not treat a well-written skill draft
as proof that production delivery is safe.

## Contract

A delivered operator message is complete only when:

- it answers the four R1 questions in plain English
- it either names a concrete user action or explicitly states that no action is required
- it stays quiet when delivery is not warranted (`NO_REPLY` / no direct send)
- it never exposes raw reason codes, stack traces, absolute paths, private skill
  names, receipt identifiers, bare commits without freshness context, or
  unreviewed diagnostic prose
- release text distinguishes published state, approval-ready candidate, and
  separate future work
- private evidence remains available to owners outside the public text

## Four questions (R1)

Every delivered message must make these answers obvious:

1. **What happened?** One concrete outcome in ordinary language.
2. **What did jarvOS do?** The automatic response already taken.
3. **Must the user act?** Yes with a specific action, or an explicit no-action line.
4. **What happens next?** The next automatic step, hold, or review path.

## Attention policy

- Prefer silence when nothing changed and no action is required.
- "Needs attention" and "needs input" are incomplete unless they name the
  exact decision, owner, and next action.
- Safe automatic holds may stay readable in status surfaces with first-seen time
  and count while direct delivery stays quiet.
- Unknown or unreviewed event codes must fail closed to a generic reviewed
  action-required message, never by printing the code.

## Privacy boundary

Keep these out of Telegram and other operator channels:

- snake_case or stable internal reason codes
- absolute filesystem paths
- stack traces and exception dumps
- private skill names and inventory logical ids
- receipt ids, run ids, and unguessable event references meant for owners
- bare git SHAs without what they establish and how fresh the observation is
- free-form diagnostic dumps or unreviewed template slots

Owners still need precision. Put codes, paths, SHAs, and detail behind
owner-only evidence, not in the public sentence.

## Release-state wording (AE5)

When projecting release monitor evidence:

- Name the **currently published** version only from current observations.
- Describe an approval-ready candidate as ready for human review and say that
  nothing publishes automatically.
- Keep a separate future lane as future work, not as a publication failure.
- Do not call normal incompleteness in a future lane a failure.
- Do not claim "current" or "ready" from stale or unknown observations.
- Keep commits, stable codes, and lane detail in owner-only evidence unless the
  public sentence explains what the commit establishes and how fresh it is.

Example shape:

> jarvOS 0.7.0 is currently published. A proposed 0.8.0 release has passed
> checks and is ready for Andrew’s review; nothing will publish automatically.
> The separate v1.0.0 milestone remains future work.

## Workflow

1. **Classify the audience.** Operator channel vs owner-only evidence.
2. **Collect facts.** Outcome, automation already attempted, action requirement,
   next automatic step, observation time, freshness.
3. **Draft the four answers** in plain English with reviewed wording.
4. **Redact.** Remove codes, paths, stacks, private names, and bare commits.
5. **Check action clarity.** Concrete action or explicit no-action statement.
6. **Validate.** Run the outbound-message lint / contract tests on fixtures or
   producers in scope.
7. **Deliver or stay quiet.** Send only when the message earns attention.

## Output format

Prefer short prose or a tight bullet block:

```text
What happened: ...
What jarvOS did: ...
Your action: ... (or "No action needed.")
Next: ...
```

Completion and recovery messages follow the same four answers. Do not celebrate
internally; state the outcome and residual risk if any.

## Anti-patterns

- Printing `skill_sync_failed` or other snake_case codes to Telegram
- "Needs attention" with no owner, decision, or next step
- Pasting stack traces, absolute paths, or receipt ids "for context"
- Calling a future milestone incomplete state a publish failure
- Claiming ready/current from stale evidence
- Using an LLM at notification time for wording
- Treating this skill alone as runtime enforcement

## Tests / evals

- Package: `modules/jarvos-skills/test/operator-communication-skill.test.js`
- Lint: `modules/jarvos-runtime-kit/test/operator-notification-lint.test.js`
- Discovery fixtures: managed projection for Codex, Claude Code, OpenClaw, Hermes
- Invocation proof is claimed only when a contained non-mutating adapter exists;
  otherwise report `verification_pending` truthfully
