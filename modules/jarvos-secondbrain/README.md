Supported source tools include `openclaw`, `codex`, `claude-code`, `hermes`,
`grok-bot`, `chatgpt`, and `custom:<slug>` for future agents. The entrypoint normalizes the
input into `CaptureEvent` v2, routes it through `jarvos-ambient`, writes through
the canonical Obsidian adapter, and uses the note optimizer so durable notes
enter the secondbrain stack. Lightweight `idea:` captures stay in the Journal
Ideas section; substantive ideas become source-backed notes linked from Ideas.
