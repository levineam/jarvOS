# @jarvos/runtime-kit

Contract, scaffold, and conformance checks for jarvOS runtime adapters.

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
node modules/jarvos-runtime-kit/scripts/jarvos-runtime-kit.js check /tmp/my-runtime/adapter.json
node modules/jarvos-runtime-kit/scripts/jarvos-runtime-kit.js scaffold my-runtime --out /tmp/my-runtime
```

## Adapter Contract

Each `runtimes/<runtime>/adapter.json` declares:

- runtime id and display name
- supported targets
- shared MCP server path and required jarvOS tools
- setup script and verification commands
- config backup behavior
- hydration mode for each target
- intentionally unsupported host capabilities

The kit validates the manifest shape and checks the adapter directory for common
drift: missing shared MCP wiring, undocumented unsupported MCP targets, missing
`jarvos_hydrate`, setup scripts that edit config without backup behavior, and
hook-based adapters that do not fail open.
