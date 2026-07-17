# Session Source Adapters

Session source adapters normalize AI coding-tool sessions into `CaptureEvent` v2
objects. They are public jarvOS contracts: callers provide source directories or
already-parsed session records, and adapters emit portable events without knowing
about a specific person's vault, machine paths, Paperclip state, or credentials.

## Supported Sources

- `openclaw`
- `codex`
- `claude-code`

Each source may also have an optional GBrain MCP connection. That connection is
runtime configuration, not part of the captured session payload. The setup smoke
for a runtime should prove:

- `gbrain --version` reports 0.42.52.0 or newer;
- `gbrain status --fast --json` returns structured status without secrets;
- `gbrain advisor --json` is available;
- the target runtime has been connected with the current GBrain connect flow,
  using an explicit MCP URL, such as
  `gbrain connect <https://brain.example.com/mcp> --agent codex --install --yes`
  or the same command with `--agent claude-code`.

Future tools should add a thin adapter around the same common normalizer when
their local session format is available.

## Input Shape

Adapters accept a parsed session object with any of these message collections:

- `messages`
- `turns`
- `entries`

Each message can expose `role`, `content` or `text`, `id` or `messageId`, and
optional `timestamp` or `model`. Session-level fields such as `id`, `sessionId`,
`title`, `startedAt`, `updatedAt`, `sourcePath`, and `privacyTier` are copied into
source metadata when present.

## Output Shape

Each emitted event is a `CaptureEvent` v2 with:

- `source.tool`, `source.sessionId`, and `source.messageId`
- `actor.type`
- `captureMode`
- `privacyTier`
- `evidence`
- `origin`

The default capture mode is `session-summary`, which requires evidence. The
default privacy tier is `local-private`; callers must opt into broader sharing.
Sessions marked `secret` are skipped instead of emitted.

## Public/Private Boundary

Public adapters may carry caller-provided paths as source pointers, but fixtures
and docs must use portable synthetic examples. Andrew's vault content, real raw
transcripts, credentials, private issue state, and machine-specific config belong
outside public jarvOS packages.

GBrain tokens, bearer credentials, OAuth state, and MCP config paths must never
be embedded in public fixtures or session captures. Adapters may report a
connection state such as `connected`, `missing`, or `unknown`, but they should not
print token values or provider secret material.

## Capture Boundary

Agents can use GBrain for brain-native lookup and writeback before or after a
session capture. They must not use that as a shortcut around `jarvos-secondbrain`
when the user asks for a note, journal entry, source-material capture, or
provenance-preserving artifact. The canonical capture path remains:

1. Normalize the tool session into a `CaptureEvent` v2.
2. Route through the shared capture contract.
3. Write notes and journal backlinks through `jarvos-secondbrain`.
4. Queue GBrain or memory-wiki downstream work from the generated knowledge
   artifact when privacy rules allow it.
