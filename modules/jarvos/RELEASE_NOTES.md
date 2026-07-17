# JarvOS Local Stack Release Notes

Status: announcement candidate. Tagging and GitHub Release creation remain
approval-gated.

## Summary

This release candidate makes JarvOS easier to try as a local personal AI
operating-system layer. The core move is a local OpenClaw profile: a checkout can
register OpenClaw as a runtime adapter, record the JarvOS skills installed for
that workspace, and verify the result with a clean install canary.

The message is intentionally simple: JarvOS is the personalization and knowledge
contract; OpenClaw is one runtime that can execute against that contract.

## Highlights

- `local-openclaw` skill pack for local runtime setup
- `jarvos-skills init --pack local-openclaw` workspace initialization
- conservative config merge that preserves existing OpenClaw runtime config
- installed skill metadata under `.jarvos/installed-skills/`
- clean install canary for `@jarvos/skills`
- starter-kit docs for the Obsidian default pack and local OpenClaw profile
- public-docs export boundary based on an allowlist, not wildcard copying

## Install Preview

From the repository root:

```bash
npm install
node jarvos-skills/bin/jarvos-skills.js init --pack local-openclaw --workspace "$PWD"
node jarvos-skills/bin/jarvos-skills.js doctor --pack local-openclaw
npm run canary:jarvos-install
```

## Boundaries

- JarvOS is Markdown-first and runtime-adapter-aware.
- OpenClaw is detected and registered, not rewritten.
- Paperclip remains the live task authority when present.
- Obsidian is a polished front door, not a hard dependency.
- Optional tools can enrich the workflow without becoming required foundations.

## Before Publishing

- Run release-intake lint.
- Run the clean install canary.
- Run the public-docs export dry run.
- Scan release artifacts for private paths, credentials, phone numbers, and
  personal schedule details.
- Record explicit approval before creating a tag or GitHub Release.
