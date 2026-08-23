---
status: active
created: 2026-08-23
updated: 2026-08-23
type: architecture
project: jarvOS
---

# Managed Runtime Topologies

jarvOS installs a harness adapter in one of two shapes. Both are produced by the
same `runtimes/<harness>/setup.sh`, and which one you get depends on whether a
stewardship dispatcher is present. This document names both, explains why the
second exists, and gives the contract a dispatcher must satisfy.

## Direct topology

The default, and what a public clone gets. Setup writes hook commands into the
harness's own configuration that point straight at the scripts in this
repository:

```text
SessionStart -> node <clone>/runtimes/claude/jarvos-session-start-hook.js
```

The path is stable because the clone is stable. Nothing sits between the harness
and the hook.

## Managed topology

Some installs do not run jarvOS from a fixed clone. A managed installer promotes
reviewed (private, public) commit pairs into *staged runtimes* — directories
named by content hash, created fresh on each promotion and reclaimed later:

```text
.../staged/managed-software-00f0b762e180/repos/jarvOS/...
.../staged/managed-software-8a524596bddb/repos/jarvOS/...
```

A hook command written directly against one of those paths would dangle at the
next promotion. So in this topology setup writes a hook command pointing at a
**stewardship dispatcher** at a stable location, and the dispatcher resolves the
currently selected runtime on every single call:

```text
SessionStart -> <stable-bundle>/jarvos-stewardship-dispatcher --harness claude --action session-start
```

The indirection is the point: the harness configuration never has to change when
the runtime is promoted, and a call can never reach a half-promoted tree — the
dispatcher fences itself on the promotion receipt and refuses to dispatch while
a transition is in flight.

## The dispatcher contract

jarvOS ships the *contract* and a *conformance checker*. It does not ship a
dispatcher implementation — that belongs to whatever installer manages the
staged runtimes.

A conforming dispatcher:

- Is invoked as `--harness <harness> --action <action>`.
- Accepts exactly the versioned action ABI, in order. The list is
  `STEWARDSHIP_ACTIONS` in
  [`modules/jarvos-runtime-kit/src/stewardship-bootstrap.js`](../../modules/jarvos-runtime-kit/src/stewardship-bootstrap.js);
  each adapter re-declares it in `stewardshipAdapter.bootstrap.actions`, and the
  validator compares element-by-element, so order is part of the contract.
- Answers `--action provenance-probe` with a JSON receipt on stdout that
  advertises its supported actions in an `actions` array. The probe is
  side-effect-free by contract, which is what makes it safe to call during
  setup and from a checker.
- Rejects an unknown action with a non-zero exit **and no receipt on stdout**. A
  rejection that prints a receipt is indistinguishable from a success to a
  caller parsing stdout.

Check any dispatcher against that contract:

```bash
node modules/jarvos-runtime-kit/scripts/jarvos-runtime-kit.js check-dispatcher <path-to-dispatcher>
```

The same check is available as a library call (`checkDispatcher`) so an
installer's own test suite can hold its real dispatcher to the public contract
rather than to a local copy of it.

### Why capabilities are advertised rather than assumed

The `actions` advertisement exists because the two halves of a managed install
live in different repositories and ship on different schedules. Without it, the
public installer can only *assume* the dispatcher implements what the public ABI
declares — and when that assumption is wrong the failure is silent and badly
timed: the hook is registered, the dispatcher rejects the action at runtime, and
on a block/allow channel like `PreCompact` a rejection blocks the operation.

So setup probes before it registers, and registers a fail-open wrapper when it
does. A dispatcher that predates capability advertising simply reports nothing,
and the installer treats that as "not supported" rather than guessing.

## Trust boundary

The dispatcher is owner-installed code that the harness executes on every
session event, with the user's own privileges. That is why the stable bundle is
owner-only, why the selector and promotion receipt are permission-checked on
each call, and why setup verifies what the dispatcher can do instead of assuming
it. A conformance check is a compatibility test, not a security control: it
tells you a dispatcher speaks the contract, not that it is trustworthy.

## Which one am I running?

If your harness configuration names `jarvos-stewardship-dispatcher`, you are on
the managed topology. If it names a script inside a jarvOS clone, you are on the
direct one.
