# Coding Tool Secondbrain Determinism

jarvOS owns intentional note and idea capture for AI coding tools. Runtime
adapters can enforce or adapt the behavior, but the product contract lives in
`jarvos-secondbrain` so installed jarvOS setups get the same behavior across
OpenClaw, Codex, Claude Code, Hermes, and future coding agents.

## Supported Coding Tools

Active first-class source tools:

- `openclaw`
- `codex`
- `claude-code`
- `hermes`
- `custom:<slug>` for future coding agents before they get a named adapter

Future non-coding assistants should start as `custom:<slug>` experiments until
the project deliberately adds them to this contract. The current determinism
target is AI coding tools.

## Required Behavior

Intentional capture requests include phrases such as `note:`, `make a note`,
`idea:`, `save this`, and equivalent explicit requests from the user.

For these requests, the coding tool must call the shared jarvOS entrypoint:

```bash
node modules/jarvos-secondbrain/scripts/jarvos-capture.js
```

The caller may also use the installed `jarvos-capture` binary or the
compatibility note/journal contract when a host has not wired the capture
entrypoint yet. The caller must not raw-write Obsidian Markdown files or invent
daily journal paths.

## Notes

Note captures must:

- write under the configured canonical `Notes/` directory
- link exactly once from `Journal/YYYY-MM-DD.md`
- never create guessed files such as `Notes/Daily Journal - YYYY-MM-DD.md`
- include source-backed `CaptureEvent` v2 metadata
- emit provenance, knowledge sidecars, QMD pending state, and downstream queues
  through the package-owned note optimizer

## Ideas

Idea captures must:

- append lightweight ideas to the journal Ideas section
- promote substantive ideas to standalone notes through the same note path
- link promoted ideas exactly once from the journal Ideas section
- preserve source, actor, origin, evidence, privacy tier, and freshness state

## Non-Capture Conversation

Ordinary conversation is not automatically ingested. A coding tool should only
write to the secondbrain stack when the user intentionally asks to capture a
note, idea, decision, quote, preference, fact, or lesson, or when a host-owned
classifier explicitly routes a source-backed event.

## Drift Checks

The package test suite includes a static determinism smoke that checks:

- active source constants are coding-tool scoped
- runtime docs and templates tell supported tools to call jarvOS-owned capture
- docs do not list general chat apps as active determinism targets
- canonical journal, exactly-one-backlink, provenance, sidecar, and QMD pending
  behavior remains documented

OpenClaw behavior is the reference benchmark, not the owner of the abstraction.
When OpenClaw gains useful deterministic behavior, move the generic rule here
and keep the runtime adapter thin.
