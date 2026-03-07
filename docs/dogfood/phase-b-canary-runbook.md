# Phase B dogfood canary runbook

Use this runbook when you want to validate the public jarvOS docs in a clean OpenClaw workspace without leaking any private overlay material back into this repo.

## 1. Prepare a clean canary workspace

1. Clone this repo into a fresh working directory.
2. Create or pick a clean OpenClaw workspace for the canary.
3. Keep your private overlay files outside this repo until the public templates are in place.

## 2. Install the public files first

Copy the public templates that ship here into the canary workspace:

- `templates/AGENTS-template.md` → `AGENTS.md`
- `templates/HEARTBEAT-template.md` → `HEARTBEAT.md`
- `templates/BOOTSTRAP-template.md` → `BOOTSTRAP.md`
- Any planning templates you want from `templates/` or `starter-kit/templates/`

## 3. Layer in the private overlay

Add the files that are intentionally operator-specific and not published in this repo, such as:

- `USER.md`
- `MEMORY.md`
- `SOUL.md`
- `IDENTITY.md`
- `TOOLS.md`
- `ONTOLOGY.md`
- Any secrets, tokens, private scripts, or channel credentials

Do not copy private overlays back into this repository.

## 4. Run the canary

1. Ask the assistant to read `BOOTSTRAP.md` and complete setup.
2. Create a small test project with a brief, board, and plan.
3. Confirm the assistant can read the installed templates and write back into the canary workspace.
4. Confirm any private integrations only come from your local overlay, not from public repo files.

## 5. Verify the public-hygiene guardrails

Before promoting changes, confirm that:

- `docs/meta/source-to-export-map.json` contains sanitized `vault://` or `workspace://` style sources rather than machine-local absolute paths
- No secrets or operator-specific paths were copied into tracked files
- The public templates still work when the private overlay is absent

## 6. Exit criteria

The canary is good when:

- bootstrap completes cleanly
- the assistant can execute a simple project loop
- the repo stays free of private files and absolute local paths
- any required private-only material remains in your local overlay

If the canary fails, capture the smallest reproducible issue, fix the public template or docs gap here, and rerun the checklist.
