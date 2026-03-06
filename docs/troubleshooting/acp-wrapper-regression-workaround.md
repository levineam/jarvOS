# ACP Wrapper Regression Workaround

This is a temporary workaround for cases where a higher-level ACP wrapper path regresses but the underlying `acpx` client still works.

## When to use this

Use the fallback when the wrapper layer fails before the request reaches the agent, for example:

- wrapper-specific argument parsing breaks
- the wrapper exits early without a usable agent response
- the wrapper adds behavior that is currently unreliable

Do not use this as the default path once the wrapper is fixed.

## Workaround

Bypass the wrapper and call `acpx` directly in one-shot mode.

### Read-only example

```bash
acpx codex exec --cwd . --approve-reads "Summarize the current repo status in 5 bullets."
```

### Structured output example

```bash
acpx codex exec --cwd . --format json --approve-reads "List the markdown files under docs/."
```

### Useful flags

- `--cwd <dir>` — pins the working directory explicitly
- `--approve-reads` — lets read/search work continue while still protecting writes
- `--approve-all` — use only when you intentionally want fully non-interactive execution
- `--timeout <seconds>` — prevents a stuck wrapper fallback from hanging forever
- `--auth-policy skip` — useful when auth prompting is the broken path and skipping is acceptable

## Operating guidance

- Keep prompts single-purpose and short
- Prefer one-shot `exec` calls over long interactive sessions while the regression is active
- Record when the fallback was used so you can remove it later
- Return to the wrapper path after the fix and verify parity with one known-good command

## When not to use it

- Multi-step interactive work that depends on wrapper state
- High-risk write operations you have not explicitly reviewed
- Cases where raw `acpx` is also failing, which usually points to a lower-level problem

## Exit criteria

Remove this workaround from active use once the wrapper path can complete the same task as a direct `acpx ... exec` call without extra manual flags or degraded behavior.
