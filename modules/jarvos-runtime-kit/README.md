# @jarvos/runtime-kit

Contract, scaffold, and conformance checks for jarvOS runtime adapters.

## Constrained generation (declaration-only)

`evaluateConstrainedGeneration(record)` evaluates a redacted, backend-neutral
generation receipt. It requires runtime-proof evidence, exact returned model
and reasoning effort, zero tools, no fallback attempts, usage evidence, and
explicit delivery denial. It never invokes a backend or changes provider
selection. The OpenClaw-shaped fixture proves only this contract's fixture
conformance; it is not preserved-runtime behavior or golden-parity evidence.
It remains `claimed-unverified`; Hermes and direct-provider backends have no
verified claim in this contract.

Runtime adapters should stay thin. Shared jarvOS capabilities live in
`@jarvos/agent-context`; adapter directories translate those capabilities into a
host runtime's native surfaces such as MCP, hooks, skills, or desktop config.

## Operator notifications (unstable)

`@jarvos/runtime-kit` also exports an unstable 0.x, transport-neutral operator
notification contract. Producers submit a versioned semantic event; the contract
validates reviewed fields and deterministically returns either plain-English
text or `NO_REPLY`. It never renders caller-supplied diagnostic prose.

Use `evaluateOperatorNotification(event)` when a host needs the attention
policy, durable-status text, and dedupe identity. Use
`renderOperatorNotification(event)` when it only needs the direct output.
Action-required events include an opaque event reference; detailed codes,
paths, commits, receipts, and process output remain in owner-only evidence.
Safe holds are durable status, while routine safe repairs and resolutions are
quiet. Release-state events separately name published, approval-ready, and
future versions; stale or unknown observations use qualified wording rather
than claiming current publication or review readiness.

`scripts/operator-notification-lint.js` also exports
`lintOperatorMessage(input)` and `lintOperatorMessages(inputs)`. They provide a
bounded local check for messages before a runtime presents them: internal codes,
paths, stack-like text, source SHAs, ambiguous attention requests, and unsafe
release wording fail closed. The script's default CLI mode checks the four
public adapter declarations; it does not send or configure notifications.

## Commands

```bash
node modules/jarvos-runtime-kit/scripts/jarvos-runtime-kit.js validate runtimes/codex/adapter.json
node modules/jarvos-runtime-kit/scripts/jarvos-runtime-kit.js check all
node modules/jarvos-runtime-kit/scripts/jarvos-runtime-kit.js check all --json
node modules/jarvos-runtime-kit/scripts/jarvos-runtime-kit.js check /tmp/my-runtime/adapter.json
node modules/jarvos-runtime-kit/scripts/jarvos-runtime-kit.js activation-status all --json
node modules/jarvos-runtime-kit/scripts/jarvos-runtime-kit.js activation-status codex --evidence /absolute/owner/evidence.json --json
node modules/jarvos-runtime-kit/scripts/jarvos-runtime-kit.js scaffold my-runtime --out /tmp/my-runtime
node modules/jarvos-runtime-kit/scripts/dogfood-managed-activation.js --help
```

`check` validates adapter contracts and local conformance. It is **not** live
activation proof. `activation-status` derives a closed public status at read
time from optional owner-local evidence. Neither command starts a harness.

## Adapter Contract

Each `runtimes/<runtime>/adapter.json` declares:

- runtime id and display name
- supported targets
- shared MCP server path and required jarvOS tools
- setup script and verification commands
- config backup behavior
- hydration mode for each target
- intentionally unsupported host capabilities
- optional `managedActivation` contract (public activation boundary; see below)

The kit validates the manifest shape and checks the adapter directory for common
drift: missing shared MCP wiring, undocumented unsupported MCP targets, missing
`jarvos_hydrate`, setup scripts that edit config without backup behavior, and
hook-based adapters that do not fail open.

## Resident runtime modes and workload routing

`runtimeMode` is an optional, declaration-only block in `jarvos.config.json`.
Its version is `jarvos-runtime-mode/v1`; the modes are `none`, `hermes`,
`openclaw`, and `multi`. `installedAdapters` records what is installed, while
`workloadRoutes` selects a consumer only in `multi`. A `telegram.updates`
workload may have exactly one consumer. `capabilityTruth` records an explicit
`available`, `unavailable`, or `unknown` state with non-empty evidence.

Configurations that do not contain `runtimeMode` are loaded as the compatible
`none` declaration. This contract has no activation behavior: it starts no
process, changes no credentials, and installs nothing.

## Runner-state compatibility reads

`readRunnerState` and `resolveTelegramCredentialReference` are fixture-only,
read-only compatibility helpers. They prefer `.jarvos/runner-state.json` and
can fall back to `.openclaw/cron/external-runner-state.json` only when the new
location is absent. The fallback emits a structured read-only compatibility
event; it never writes or migrates the legacy file.

A route record contains exactly `routeIdentity`, `secretStoreRef`, and
`revision`. The resolver rejects raw-token-shaped configuration fields, unsafe
paths or symlinks, duplicate Telegram routes, and conflicting new/legacy
records. It has no default home-directory lookup, so it cannot inspect a live
installation until a separately reviewed adapter deliberately opts in.

Telegram is a route dimension, not a harness name: identities such as
`openclaw:telegram:default` and `hermes:telegram:default` are recognized but
returned exactly as written. Compatibility fallback always returns structured
read-only evidence, whether or not an optional observer is supplied. Files are
opened with no-follow descriptors and revalidated against their inspected
identity and fixture-root containment before they are parsed.
The descriptor and filesystem helpers are internal implementation details; the
public API returns only validated, sanitized state records.

`runtimeMode.conformanceFacts` is an optional `jarvos-harness-conformance/v1`
registry. Its tiers are `baseline-context`, `conversational`,
`mutation-capable`, and `proactive-authority`. A
`telegram.proactive-delivery` route is rejected unless its selected harness has
a verified `proactive-authority` fact bound to the exact installed tuple
(harness, runtime version, and asset digest). Hooks are descriptive evidence,
not proactive proof. The checked-in Hermes and OpenClaw declarations are both
`claimed-unverified` pending owner-local Mac Mini proof; this repository does
not run that proof or activate either harness.

Conformance facts currently name only `hermes` or `openclaw`. Their registered
adapter manifests must bind every fact to their own id and declare all four
tiers once, in the canonical order above.

## Managed harness activation

Managed activation answers whether a harness is **live under a selected public
tuple**, not whether it is installed, registered, healthy, or skill-visible.

Public contract source of truth: `managedActivation` embedded in each
`runtimes/{claude,codex,hermes,openclaw}/adapter.json`. There is no second
global activation registry. A local `managed-launcher.json`, when present, is
**installation evidence only** — not an activation flag or manifest.

| Harness | Execution owner | jarvOS background process |
| --- | --- | --- |
| Claude, Codex | `native-hooks` | none (managed launcher is a per-session fallback, not a daemon) |
| Hermes, OpenClaw | `harness-process` | none (host/gateway owns process lifetime) |

jarvOS does not enable a supervisor or restart loop for symmetry.

State is derived at read time (`unconfigured`, `prepared`, `awaiting_live_proof`,
`active`, `degraded`, `rollback_pending`, `rolled_back`) and never stored as an
`active` boolean. `active` requires a fresh causal receipt bound to the exact
tuple of harness, generation, asset digest, entrypoint digest, and config-binding
digest. Freshness is 15 minutes with at most 30 seconds forward skew. Health may
explain degradation but cannot activate. Public status is redacted (harness,
state, generation digest, evidence classes, times, allowlisted reasons only).

Production receipts must name the selected-runtime bridge as their producer and
the exact adapter-declared native event (`SessionStart` / `UserPromptSubmit` for
Claude and Codex, `managed_session_start` / `pre_llm_call` for Hermes, or
`managed_session_start` / `agent_turn_prepare` for OpenClaw). Test-fixture
provenance is accepted only by the explicitly gated package test mode and is
rejected by production status evaluation.

Disposable dogfood is two-phase and never starts a process on prepare:

```bash
# prepare — absolute disposable owner root + exact input file paths
node modules/jarvos-runtime-kit/scripts/dogfood-managed-activation.js prepare \
  --harness codex \
  --owner-root /absolute/disposable/owner-root \
  --generation public-gen-example \
  --asset /absolute/disposable/selected-asset.js \
  --entrypoint /absolute/disposable/stable-entrypoint.js \
  --config-binding /absolute/disposable/config-binding.toml \
  --json

# real harness lifecycle event(s) must occur here for the prepared challenge

# verify — re-attest; exact-owned rollback only when bytes/modes still match
node modules/jarvos-runtime-kit/scripts/dogfood-managed-activation.js verify \
  --harness codex \
  --owner-root /absolute/disposable/owner-root \
  --run <opaque-run-id-from-prepare> \
  --json
```

Fixture receipts do not prove a live harness. Package skill preflight remains
`activating: false`, `readOnly: true`, with live gates off; it reads only
redacted status and cannot start or promote a harness. Live local adoption is
only after a public merge staged through the selected-runtime mechanism — never
against a dirty root or active real profile.

On a successful disposable verify, the evaluator first proves `active`, then
exact-owned cleanup consumes the challenge and invalidates that generation's
test evidence. The returned public state is therefore `rolled_back`, paired
with `dogfood.outcome: passed`; it is not a durable active claim.

Operator detail: [`docs/runbooks/managed-harness-activation.md`](../../docs/runbooks/managed-harness-activation.md).
