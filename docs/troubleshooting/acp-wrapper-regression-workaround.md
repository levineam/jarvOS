# ACP wrapper regression workaround

Use this workaround only when a wrapper command regresses and blocks normal execution, but the underlying `acpx` command still works.

## Safe fallback

1. Confirm the failure is in the wrapper layer rather than in the underlying task.
2. Run the smallest possible direct `acpx` command needed to unblock the task.
3. Capture the exact failing wrapper behavior and the successful direct invocation so the wrapper can be repaired.
4. Return to the standard wrapper path as soon as the regression is fixed.

## Guardrails

- keep the fallback temporary
- do not widen permissions or automation scope just because the wrapper failed
- record any direct-command workaround in the relevant project notes or changelog
- avoid baking the workaround into public templates unless the regression is persistent and broadly reproducible

## What to collect for follow-up

- wrapper command that failed
- exact error output
- direct `acpx` command that succeeded
- any environment assumptions required to reproduce the issue
