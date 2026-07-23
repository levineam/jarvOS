---
name: jarvOS
last_updated: 2026-07-09
status: draft — authored 2026-07-09, landed unreviewed 2026-07-22 to stop it being lost
---

# jarvOS Strategy

> **Provenance note (2026-07-22).** This document was written on 2026-07-09 and then sat
> uncommitted in a working copy for thirteen days while the Control Plane program took priority.
> It is landed here to make it durable and reviewable, not because it has been re-ratified.
> Two of its factual claims were re-verified against shipped v0.7.0 before landing: cold install
> now passes (metric updated below), and the CI test gap it describes under "Prove it works" was
> still real and is addressed separately. Treat the positioning, tracks and non-goals as a draft
> awaiting the maintainer's confirmation that they still reflect intent.

## Target problem

Someone running several AI agents against their own files and notes cannot tell whether an agent
actually followed their rules or actually did the work — they only see that the rules were loaded
into context and that the agent said "done." The crux: the only evidence is a report written by the
same system that may have failed, so silent losses (a truncated note, a skipped step, a rule quietly
ignored) surface days later, by accident, if at all.

## Our approach

Evidence over assertion. jarvOS commits to enforcing rules with checks that run whether or not the
agent cooperates, and to making every claim of "done" carry a receipt some other process verified.
We would rather ship fewer capabilities that are provably enforced than more capabilities that are
merely documented — which means we do not compete on retrieval quality, on vault formats, or on
being a rules *standard*, and we do not ship a release we would not stake our own daily work on.

## Who it's for

**Primary:** The multi-agent power user — someone already running two or more coding agents against
their own notes and repos, who has been burned by silent loss at least once. They're hiring jarvOS to
keep one brain across those agents and to be able to prove that nothing got quietly dropped or skipped.

## Key metrics

- **Cold-install pass rate** — share of fresh clones where the documented quick start reaches its
  advertised success line, measured by a CI job on a clean container. Today: passing as of v0.7.0
  — re-verified 2026-07-22 by packing the tarball and installing it against a virgin `HOME`
  (populated workspace, 20/20 checks) and by running the documented `npm test` quick start
  (65/65, advertised success line reached). Not yet measured by a CI job on a clean container,
  so this number is hand-verified rather than continuously enforced.
- **Time to first value** — minutes from `git clone` to the assistant doing something visibly useful
  on a clean machine, without installing a second un-bundled runtime. Measured by hand each release.
- **Enforced-rule coverage** — share of rules in the shipped rulebook that have an automated check
  which fails when the rule is violated. Regresses whenever a rule is added without a check.
- **Verified-done rate** — share of agent "done" claims that carry a machine-checkable receipt rather
  than prose. This is the wedge, made countable.
- **Silent-failure escapes** — count of data-integrity incidents per week that reached the user's
  files, split by detected-by-check vs discovered-by-accident. The second number is the one that matters.

## Tracks

### Trust the front door

Install, first run, and doc honesty: the documented path must work on a clean machine, and the docs
must describe only what is actually shipped.

*Why it serves the approach:* The front door is the first claim the product makes. If it asserts
"just works" and then fails on the first command, every later promise about enforcement is worthless.

### Prove it works

Wire the existing test suite into CI, ship the data-integrity guards that currently exist only in the
maintainer's private checkout, and treat the maintainer's daily use as the release gate.

*Why it serves the approach:* "Evidence over assertion" has to apply to jarvOS itself first. A repo
with nine journal test files that CI never runs is asserting, not proving.

### Enforcement and receipts

The differentiating mechanic: rules that are checked rather than merely loaded, and work that emits a
verifiable record of what was done and how it was confirmed.

*Why it serves the approach:* This is the only claim in the category that competitors do not already
make. Memory layers answer "what does the agent remember." None answer "did it actually do the thing,
and can I prove it."

## Not working on

- Competing on retrieval quality or benchmark scores against dedicated memory layers.
- A hosted service, cloud tier, or any component that requires trusting a server.
- Becoming a rules *format*. jarvOS reads the existing standard; it does not replace it.
- Broadening runtime support before at least two runtimes are provably solid.
- Cutting further releases before the trust bar in "Prove it works" is met.

## Marketing

**One-liner:** One brain for all your agents — and a receipt for everything they do.

**Key message:** Every other second brain stores what your agent remembers. jarvOS checks what your
agent did. Rules are enforced, not just loaded; "done" comes with evidence, not a promise.
