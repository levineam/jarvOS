# @jarvos/runtime-kit

Contract, scaffold, and conformance checks for jarvOS runtime adapters.

Runtime adapters should stay thin. Shared jarvOS capabilities live in
`@jarvos/agent-context`; adapter directories translate those capabilities into a
host runtime's native surfaces such as MCP, hooks, skills, or desktop config.

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
drift: missing shared MCP wiring, missing `jarvos_hydrate`, setup scripts that
edit config without backup behavior, and hook-based adapters that do not fail
open.
