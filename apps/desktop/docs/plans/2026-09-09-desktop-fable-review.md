# DESKTOP-20260908 — Fable plan review

Reviewed September 9, 2026 through the managed Claude Max launcher. Andrew explicitly authorized this one review. The packet contained only the September 8 implementation plan; tools, customizations and MCP were disabled. Authentication was logged-in `claude.ai` / `max` with no API-key fallback.

Receipt: session `d2882812-8497-4aec-a0bf-17d9a242a193`, result UUID `1a675a1b-7035-430d-8bdb-100c143e6d89`, `is_error: false`, substantive `modelUsage.canonicalModel: claude-fable-5-1`, one turn, no tool permissions requested. Usage: 2 input, 7,414 cache-creation, 5,664 output tokens. List-price-equivalent telemetry is not a subscription charge.

## Findings and disposition

The review was not a clean PASS. Four material plan gaps were found and incorporated into the plan before implementation:

1. **Agent execution boundary:** app-server is not a plain text completion service. Explicitly isolate its working directory, disable inherited MCP/tools, default-deny execution requests and prove no writes from chat. Do not assume a read-only filesystem sandbox alone constrains remote MCP mutations.
2. **Avatar test semantics:** compare positions at identical seed and time across speech/luminance changes. Drift may vary with time only. Use matched interior windows for spatial density checks; do not mistake the global head envelope for facial clustering.
3. **Projects scope:** pass the provider's explicit scope and timestamp to the UI. Missing scope must read partial/unknown, never whole portfolio.
4. **PR overlap:** keep new adapters/view/test logic modular and shared-file edits small. PR #6 is still open at `4394c6f196dac7801644bc04c461f58ba966322a` on September 9. Reconcile the exact competing head before submission, with conflict/integration proof; this does not authorize merging someone else's PR or blindly waiting indefinitely for it.

Additional accepted cautions: validate loopback Host as well as Origin; omit global logout from Desktop; require actual human sign-in if no reusable session exists; verify official app-server/client authentication support instead of treating a reviewer's policy concern as established fact.

These are incorporated planning corrections, not implementation or runtime proof. The implementation still owes the plan's source tests, rendered UI, exact-head review and genuine subscription-backed conversation.
