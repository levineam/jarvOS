# JarvOS Local Stack Install Guide

This guide installs the current JarvOS local OpenClaw profile from a repository
checkout. It is the announcement-ready path for the local stack preview, not a
tagged package release.

## What You Get

- Markdown-first JarvOS workspace contracts
- a local OpenClaw runtime adapter registration
- JarvOS skill-pack metadata under `.jarvos/installed-skills/`
- optional continuity checks for tools such as `lossless-claw`
- clean install canary evidence for the JarvOS skills package

JarvOS does not replace OpenClaw, Paperclip, GBrain, or Obsidian. It gives them a
portable contract: Markdown for human-readable knowledge, JSON for machine
state, and explicit adapters for runtime-specific behavior.

## Requirements

- Node.js 18 or newer
- npm
- a local repository checkout
- optional: an existing OpenClaw config if you want the runtime adapter to detect
  a live OpenClaw installation
- optional: `lossless-claw` for continuity checks
- optional: Obsidian and `defuddle` for the Obsidian default experience pack

## Install

Run these commands from the repository root:

```bash
npm install
node jarvos-skills/bin/jarvos-skills.js init --pack local-openclaw --workspace "$PWD"
node jarvos-skills/bin/jarvos-skills.js doctor --pack local-openclaw
npm run canary:jarvos-install
```

The init command is conservative. It merges missing JarvOS defaults into
`jarvos.config.json`, writes JarvOS skill-pack metadata, and preserves existing
OpenClaw runtime config.

## Verify

The local stack is release-ready only when these checks pass:

```bash
npm run lint:jarvos-release-intake
npm test -- tests/scripts/jarvos-clean-install-canary.test.js
npm run canary:jarvos-install
```

The canary packs `@jarvos/skills`, installs the generated tarball into a fresh
temporary project, and runs the installed doctor. This proves the install
artifact works outside the source checkout.

## Public/Private Boundary

Safe to publish:

- workspace contract docs
- starter templates
- install commands
- clean canary summaries
- feature boundaries and adapter behavior

Do not publish:

- tokens, API keys, cookies, or private keys
- personal paths, schedules, phone numbers, or mailbox content
- private Paperclip issue details beyond public release summaries
- machine-local runtime config values

## Release Gate

These docs prepare the announcement package. They do not authorize a tag or
GitHub Release. Cut the tag only after an explicit approval records the final
version, release notes, changelog entry, and public/private boundary check.
