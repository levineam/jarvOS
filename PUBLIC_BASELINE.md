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

---

## What is NOT in this repo (private — stays local)

### Personal ontology content
- `ontology/*.md` — Andrew's actual beliefs, predictions, goals, projects (highly personal)
- `bridge-state.json` — Paperclip entity ID mappings for Andrew's ontology sync

### Personal memory
- `MEMORY.md` — Andrew's curated long-term agent memory
- `memory/` — daily session logs and notes

### Personal configuration
- `jarvos.config.json` — actual paths to Andrew's vault, workspace, etc.
- Any file with hardcoded absolute paths to `/Users/andrew/`

### Vault content
- Obsidian vault notes and journal entries
- `~/Documents/Vault v3/` or any user-specific vault path

### Runtime secrets
- API keys, tokens, credentials (never in any repo)
- Paperclip project IDs (pcp_*)

---

## Design Principle

> **Code is public. Content is private.**

The modules in `modules/` contain generic, configurable code. They use environment variables and config files to find user-specific paths — no hardcoded user data in source.

When you clone this repo and use it:
1. The code runs against **your** vault, **your** workspace, **your** ontology
2. None of Andrew's data is included
3. The templates give you blank starting points to fill in

---

## Adding to This Repo

Before committing new files, ask:
- Does this file contain personal data (names, IDs, paths, content)?
- Does this file reference a specific user's filesystem layout?
- Would a stranger cloning this repo see something they shouldn't?

If yes to any: keep it local, add it to `.gitignore`, document it here.

---

_Last updated: SUP-487 (2026-03-27). Branch: feat/sup-487-include-module-code_
