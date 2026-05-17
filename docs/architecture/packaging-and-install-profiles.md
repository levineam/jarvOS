---
status: active
created: 2026-05-17
updated: 2026-05-17
type: roadmap
project: jarvOS
source: SUP-1772
related:
  - SUP-1765
---

# jarvOS Packaging and Install Profiles

This roadmap turns the SUP-1765 product-category research into a concrete
packaging plan. The product shape is:

> jarvOS is local middleware for personal AI systems: a portable operating layer
> that owns memory, notes, ontology, skills, workflow rules, and execution
> context, while agent runtimes own model calls, sessions, tools, and delivery.

That means jarvOS should install like developer-facing local infrastructure:
one honest happy path, explicit profiles for optional subsystems, and a doctor
command that proves the local system is understandable after setup.

## Source Assumptions

- SUP-1765 recommends the category "portable personal-AI operating layer."
- OpenClaw is a runtime adapter, not the jarvOS product boundary.
- Markdown files remain the human-owned control plane.
- Paperclip owns live execution state when enabled.
- GBrain and graph recall are optional structured-knowledge subsystems.
- Obsidian is a first-class markdown client, not a hard dependency.
- `lossless-claw` belongs inside the OpenClaw profile because it is an OpenClaw
  plugin, not jarvOS core.

## Packaging Principles

1. **Small required core.** A user should be able to install jarvOS without
   installing every adjacent system.
2. **Profiles over hidden magic.** Runtime, execution, vault, and graph features
   are selected through named profiles with visible dependencies.
3. **Doctor before confidence.** Every profile must have a matching health check.
4. **Adapters stay replaceable.** OpenClaw, Codex, Claude, Hermes, Paperclip, and
   GBrain should be plugged in through boundaries, not baked into core state.
5. **Installed state stays readable.** The setup command can copy, validate, and
   scaffold files, but the result should remain normal markdown and JSON.

## Required Core

The core install should require only:

- Node.js 18 or newer
- the `jarvos` CLI
- a local jarvOS workspace
- a markdown notes directory
- generated core files:
  - `AGENTS.md`
  - `SOUL.md`
  - `USER.md`
  - `MEMORY.md`
  - `ONTOLOGY.md`
  - `TOOLS.md`
  - `jarvos.config.json`
- the `@jarvos/agent-context` MCP server or equivalent runtime-facing context
  interface
- one runtime adapter selected during setup

Everything else is a profile dependency.

## Install Profiles

### `minimal`

Purpose: inspectable local workspace with no live automation dependency.

Includes:

- core markdown files and templates
- `jarvos.config.json`
- local notes directory
- static validation with `jarvos doctor --profile minimal`

Does not include:

- runtime daemon setup
- Paperclip
- GBrain
- `lossless-claw`
- Obsidian app automation

Use this profile for docs, workshops, and contributors who want to understand
the file contract before wiring a runtime.

### `local-openclaw`

Purpose: recommended developer happy path for a working local personal AI
operating layer.

Includes:

- everything in `minimal`
- OpenClaw runtime detection and onboarding
- jarvOS OpenClaw adapter files
- `@jarvos/agent-context` registration
- `@jarvos/skills` installation
- optional `lossless-claw` plugin install and verification
- Paperclip prompt during setup, defaulting to enabled when credentials exist

Doctor checks:

- OpenClaw CLI is present
- daemon or gateway is healthy when daemon mode is requested
- jarvOS core files are loaded from the expected workspace
- MCP adapter is reachable
- installed skills match the expected skill manifest
- `lossless-claw` status is healthy when enabled

### `codex`

Purpose: let Codex CLI consume jarvOS recall, current-work, and note-capture
tools without requiring OpenClaw.

Includes:

- everything in `minimal`
- Codex adapter setup
- MCP registration instructions or generated config
- startup brief and current-work hydration checks

Doctor checks:

- Codex config references the local jarvOS MCP server
- MCP tool list includes recall, startup brief, current work, and note capture
- generated paths do not include private machine-specific examples

### `claude`

Purpose: expose jarvOS context to Claude Desktop or Claude Code style clients.

Includes:

- everything in `minimal`
- Claude-compatible MCP setup guidance
- optional `CLAUDE.md` generation from jarvOS core

Doctor checks:

- generated MCP config points at the local jarvOS adapter
- `CLAUDE.md` exists when requested
- setup does not overwrite user-owned Claude config without confirmation

### `hermes`

Purpose: add jarvOS behavior and local context to Hermes Agent without
duplicating Hermes-native memory or learning systems.

Includes:

- everything in `minimal`
- Hermes adapter setup
- jarvOS behavior-layer files
- optional startup brief integration

Doctor checks:

- Hermes CLI or config is detected
- jarvOS files are discoverable from the Hermes workspace
- no Hermes-native model, session, or learning config is overwritten

### `full`

Purpose: complete local operating layer for serious daily use.

Includes:

- `local-openclaw`
- Paperclip execution tracker
- GBrain structured knowledge adapter
- Obsidian-compatible markdown vault
- release-grade doctor and smoke verification

Doctor checks:

- all `local-openclaw` checks
- Paperclip API reachability and issue-create permission
- configured Paperclip project mapping
- GBrain stats, fast doctor, and recall smoke
- vault path exists and contains required journal and notes roots
- public/private boundary scan passes

## Expected CLI Shape

The current `bootstrap.js` script is a good v0.1 bootstrapper, but the product
should graduate to a command router:

```bash
npm install -g jarvos
jarvos init --profile local-openclaw
jarvos doctor
jarvos adapter add codex
jarvos adapter check all
jarvos update
```

The package rename should happen when these commands exist:

- from `jarvos-bootstrap` to `jarvos`
- from `jarvos-bootstrap` / `jarvos-init` binaries to one `jarvos` binary
- keep compatibility aliases for at least one release after the rename

## Profile Manifest Contract

Profiles should be machine-readable before they become complex. A manifest lets
docs, CLI prompts, doctor checks, and tests share the same dependency matrix.

Recommended path:

```text
profiles/
├── minimal.json
├── local-openclaw.json
├── codex.json
├── claude.json
├── hermes.json
└── full.json
```

Recommended shape:

```json
{
  "id": "local-openclaw",
  "title": "Local OpenClaw",
  "extends": "minimal",
  "required": ["node", "workspace", "vault", "agent-context", "openclaw"],
  "optional": ["lossless-claw", "paperclip", "gbrain"],
  "writes": ["core-files", "jarvos.config.json", "skills", "runtime-adapter"],
  "doctorChecks": [
    "workspace-files",
    "config-schema",
    "vault-path",
    "agent-context-mcp",
    "openclaw-runtime",
    "skills-manifest"
  ]
}
```

The manifest should describe desired state. Install commands and doctor checks
can interpret it, but it should not contain machine-local secrets or absolute
private paths.

## Versioned Roadmap

### v0.2 — Packaging Clarity

Goal: make the current public repo honest and navigable before changing install
mechanics.

Deliverables:

- publish this packaging and install-profile roadmap
- add or merge the product category and runtime-boundary doc from SUP-1768
- document required core vs optional profile dependencies
- decide which modules are public packages and which remain internal
- add profile manifest stubs if the CLI is ready to consume them soon

Done when:

- a new contributor can explain the install tiers without reading private notes
- README and architecture docs stop implying that OpenClaw is mandatory core
- no profile claims automation that the repo cannot verify

Size: Small to medium docs and metadata work.

### v0.3 — CLI and Doctor

Goal: replace "copy these files manually" as the primary product experience.

Deliverables:

- introduce a `jarvos` command router
- move existing bootstrap behavior under `jarvos init`
- add `jarvos doctor`
- add profile manifest loading
- validate `jarvos.config.json` against schema
- keep old binary aliases during migration

Done when:

- `jarvos init --profile minimal` creates a workspace in a temp directory
- `jarvos doctor --profile minimal` passes on that workspace
- the old bootstrap smoke test still passes through a compatibility path

Size: Large. This changes the executable surface and test model.

### v0.4 — Local OpenClaw Profile

Goal: make the recommended local runtime setup real instead of aspirational.

Deliverables:

- implement `jarvos init --profile local-openclaw`
- detect or guide OpenClaw onboarding
- register jarvOS adapter files without overwriting user-owned runtime config
- install `@jarvos/skills`
- optionally install and verify `lossless-claw`
- add runtime smoke tests for OpenClaw profile output

Done when:

- a clean local machine with Node and OpenClaw can complete init and doctor
- `lossless-claw` is checked only when the user enables it
- generated files are readable and reversible

Size: Large. This touches runtime setup, user config safety, and profile doctor
checks.

### v0.5 — Paperclip and GBrain Fullness

Goal: make the "full" profile credible for daily operation.

Deliverables:

- Paperclip adapter config and doctor checks
- Paperclip project mapping validation
- issue-create permission probe with safe dry-run behavior
- GBrain adapter config and doctor checks
- GBrain recall smoke test with fixture data
- vault path validation and journal/notes root checks

Done when:

- `jarvos doctor --profile full` can distinguish missing optional credentials
  from broken configuration
- Paperclip remains execution state, not memory
- GBrain remains structured recall, not raw notes storage

Size: Medium to large. Most risk is in credential-safe verification and clear
failure messaging.

### v1.0 — Clean-Machine Confidence

Goal: make jarvOS installable by a technically capable stranger.

Deliverables:

- clean-machine install canary
- release checklist covering every profile
- public/private boundary scan
- upgrade path from `jarvos-bootstrap`
- rollback or repair guidance
- documented compatibility matrix for supported runtimes

Done when:

- `npm install -g jarvos && jarvos init --profile local-openclaw && jarvos doctor`
  works on a clean machine with documented prerequisites
- `minimal`, `codex`, `claude`, `hermes`, `local-openclaw`, and `full` profiles
  each have explicit pass/fail criteria
- no private data, local path, or Paperclip instance detail is required to pass
  the public smoke suite

Size: Large. This is release hardening, not just feature work.

## Biggest Implementation Changes

| Change | Size | Risk | Notes |
| --- | --- | --- | --- |
| Rename package from `jarvos-bootstrap` to `jarvos` | Medium | Medium | Needs compatibility aliases and release notes. |
| Replace script entrypoint with CLI command router | Large | Medium | Keep `bootstrap.js` behavior callable until migration is done. |
| Add profile manifest loader | Medium | Low | Keep manifests declarative and secret-free. |
| Implement `jarvos doctor` | Large | High | Doctor becomes the trust surface for every profile. |
| Implement `local-openclaw` profile | Large | High | Must not overwrite existing OpenClaw config silently. |
| Add optional `lossless-claw` install/check | Medium | Medium | OpenClaw-only dependency; avoid making it jarvOS core. |
| Add Paperclip doctor checks | Medium | Medium | Must verify capability without leaking credentials or creating junk issues. |
| Add GBrain doctor checks | Medium | Medium | Needs fixture-backed recall smoke, not private graph data. |
| Add clean-machine install canary | Large | High | Requires reliable prerequisites and cleanup. |

## Execution-Ready Follow-Up Issues

These are the smallest follow-up slices that are ready to become Paperclip
issues. They should stay separate so docs, CLI migration, runtime integration,
and full-profile health checks do not block each other.

1. **v0.2 profile manifest stubs**
   - Scope: add `profiles/*.json` for `minimal`, `local-openclaw`, `codex`,
     `claude`, `hermes`, and `full`; add schema validation tests.
   - Done: `npm test` validates manifests and no manifest contains secrets or
     absolute private paths.

2. **v0.3 CLI command router**
   - Scope: introduce a `jarvos` binary and route existing bootstrap behavior to
     `jarvos init`.
   - Done: old bootstrap aliases still work and `jarvos init --help` documents
     profiles.

3. **v0.3 minimal doctor**
   - Scope: implement `jarvos doctor --profile minimal` for workspace files,
     config schema, vault path, and agent-context presence.
   - Done: temp-workspace smoke test passes and failure output names the exact
     missing component.

4. **v0.4 local-openclaw profile**
   - Scope: implement OpenClaw detection/onboarding, adapter registration, skill
     install, and optional `lossless-claw` checks.
   - Done: local-openclaw init and doctor pass in a clean test workspace without
     overwriting existing runtime config.

5. **v0.5 Paperclip and GBrain doctor checks**
   - Scope: add credential-safe Paperclip and fixture-backed GBrain checks for
     the `full` profile.
   - Done: doctor distinguishes skipped, missing, and broken optional subsystems
     and never prints tokens, headers, or private graph content.

6. **v1.0 clean-machine canary**
   - Scope: create an automated install rehearsal for supported profiles.
   - Done: the canary runs from a fresh clone or package install and records
     profile-specific pass/fail evidence.

## What Not to Build Yet

- Do not make Docker the default install path while jarvOS is primarily CLI,
  markdown, and adapters.
- Do not bundle OpenClaw or `lossless-claw` as mandatory jarvOS dependencies.
- Do not build a desktop app before the CLI, profiles, and doctor are reliable.
- Do not turn Paperclip into jarvOS memory.
- Do not require Obsidian; require a markdown vault contract.
- Do not publish module-level install promises for packages that remain private.

## Reusable Pattern

For another personal-AI operating system, use the same structure:

1. Define the small required core.
2. Move every adjacent subsystem into named profiles.
3. Give each profile a manifest.
4. Make the doctor command mirror the manifest.
5. Version the roadmap by user confidence, not by internal implementation order.

The important product move is not "add an installer." It is making the boundary
between core, adapters, optional subsystems, and verification explicit enough
that another person can adopt the system without inheriting the original
author's private machine.
