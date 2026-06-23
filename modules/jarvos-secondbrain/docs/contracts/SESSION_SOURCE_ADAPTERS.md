# Session Source Adapters

Session source adapters normalize AI coding-tool sessions into `CaptureEvent` v2
objects. They are public jarvOS contracts: callers provide source directories or
already-parsed session records, and adapters emit portable events without knowing
about a specific person's vault, machine paths, Paperclip state, or credentials.

## Supported Sources

- `openclaw`
- `codex`
- `claude-code`
- `hermes`

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
