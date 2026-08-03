# PUBLIC_BASELINE.md — Public vs Private Boundary

This document defines what is and is not included in the public jarvOS repository.

---

## What IS in this repo (public)

### Core behavioral layer
- `core/` — portable AGENTS.md, SOUL.md, IDENTITY.md behavioral rules
- `templates/` — blank templates you fill in (USER.template.md, MEMORY.template.md, ONTOLOGY.template.md, TOOLS.template.md)
- `starter-kit/` — governance workflow templates and project management scaffolding
- `runtimes/` — runtime adapter docs for OpenClaw and Hermes
- `examples/` — usage examples
- `docs/` — architecture docs and guides

### Module code (added in SUP-487)
- `modules/jarvos-memory/` — agent-state memory contract (schema, audit helpers, promotion rules)
- `modules/jarvos-ontology/` — ontology tooling (reader, writer, validator, renderer, blank templates)
- `modules/jarvos-secondbrain/` — content layer (journal/notes packages, vault bridges, capture routing)
- `modules/jarvos-gbrain/` — GBrain-first resolver/brain integration code, public template manifest, public template eval fixture
- `modules/jarvos-skills/` — generic operating-system skills for workflow execution, rule creation, context management, and cron hygiene

---

## What is NOT in this repo (private — stays local)

### Personal ontology content
- `ontology/*.md` — a maintainer's actual beliefs, predictions, goals, projects (highly personal)
- `bridge-state.json` — Paperclip entity ID mappings for a maintainer's ontology sync

### Personal memory
- `MEMORY.md` — a maintainer's curated long-term agent memory
- `memory/` — daily session logs and notes

### Personal configuration
- `jarvos.config.json` — a user's actual paths to their vault and workspace
- Any file with hardcoded absolute paths to a developer's machine

### Vault content
- Obsidian vault notes and journal entries
- Any user-specific vault path

### GBrain content
- `~/brain/` or any user's generated GBrain pages
- Local curated import manifests that list private vault files
- Local retrieval-eval question sets that contain private facts

### Runtime secrets
- API keys, tokens, credentials (never in any repo)
- Paperclip project IDs (pcp_*)

---

## Design Principle

> **Code is public. Content is private.**

The modules in `modules/` contain generic, configurable code. They use environment variables and config files to find user-specific paths — no hardcoded user data in source.

When you clone this repo and use it:
1. The code runs against **your** vault, **your** workspace, **your** ontology
2. None of a maintainer's personal data is included
3. The templates give you blank starting points to fill in

---

## Adding to This Repo

Before committing new files, ask:
- Does this file contain personal data (names, IDs, paths, content)?
- Does this file reference a specific user's filesystem layout?
- Would a stranger cloning this repo see something they shouldn't?

If yes to any: keep it local, add it to `.gitignore`, document it here.

---

## Journal reliability boundary

The public journal contract is portable and configuration-driven:

- journal mutation requires an explicit journal directory and valid IANA timezone;
  it never falls back to a home-directory vault or an implicit local timezone
- the package-owned lifecycle creates only the missing current-date file and
  never repairs or rewrites an existing authored journal on the creation path
- canonical dated journals and derived indexes have separate health and
  ownership rules
- host schedulers, runtime identities, receipts, and live-vault evidence stay
  outside this repository

See [`docs/journal-install-contract.md`](docs/journal-install-contract.md) for
the install and host-adapter contract.

_Last updated: 2026-08-03._
