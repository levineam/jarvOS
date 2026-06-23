# Automatic Secondbrain Public Boundary

This document defines what belongs in public jarvOS for the automatic
secondbrain stack and what must stay private/local.

## Public jarvOS

These surfaces are generic and portable:

- `CaptureEvent` v2 schema and validation.
- Session source adapter interfaces and generic adapters for OpenClaw, Codex,
  Claude Code, and Hermes.
- Knowledge-unit sidecar schema and queue contracts.
- Generated LLM-wiki compiler.
- qmd, generated-wiki, and graph retrieval eval harnesses.
- Promotion gates for memory and ontology.
- Watch/status reporter.
- Config templates and docs for any Obsidian-compatible Markdown vault.
- Synthetic fixtures and tests.

Public examples must use portable paths such as `~/Vaults/MyVault/Notes` or
`/workspace/sessions/example.json`. They must not include a real person's vault
content, raw transcripts, credentials, private issue state, personal ontology
facts, or machine-specific paths.

## Private/Local State

These stay outside public jarvOS:

- Actual vault notes and journals.
- Raw coding-agent transcripts.
- Credentials, tokens, cookies, or API keys.
- Personal ontology data.
- Private Paperclip issue state and comments.
- Local dogfood config and machine-specific paths.

Local dogfood should be opt-in through config or flags. Disabling those flags
and deleting generated wiki output must return the system to source notes,
journals, qmd, and existing reviewed memory queues as the authority.

## Release Path

This document now describes shipped v0.6.x secondbrain surfaces plus
post-v0.6.1 hardening work. New capture-determinism changes belong under a
future v0.6.x patch or the next focused minor lane unless a release issue
explicitly pulls them forward. Do not rewrite shipped v0.5.0, v0.6.0, or
v0.6.1 release history to claim later hardening work.

Before public promotion:

- Run the secondbrain package tests.
- Run memory and ontology promotion-gate tests.
- Run release-intake lint.
- Run privacy/path scans over public docs, fixtures, generated pages, and config
  templates.
- Run retrieval evals and record source-evidence results.
- Confirm generated wiki pages are rebuildable and source notes remain
  authoritative.
- Record rollback: disable secondbrain dogfood flags, delete generated wiki
  output, and rely on journals, source notes, qmd, and existing reviewed queues.

## Public Destinations

When copied into the public jarvOS repository, place the generic surfaces under:

- `repos/jarvOS/modules/jarvos-secondbrain/`
- `repos/jarvOS/modules/jarvos-memory/`
- `repos/jarvOS/modules/jarvos-gbrain/`
- `repos/jarvOS/modules/jarvos-skills/packs/`
- `repos/jarvOS/docs/`
