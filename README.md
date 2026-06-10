# jarvOS Desktop

**A unified local-first desktop interface for the jarvOS operating layer.**

One window that shows everything jarvOS stitches together: the daily journal
stream, the notes vault, Paperclip work, durable memory, the ontology meaning
spine, and the health of the bundled services.

This is a prototype. It reads the same sources of truth the agents use — it
does not invent its own database.

## Pages

| Page | Layer | Source |
| --- | --- | --- |
| **Today** | Control room | Composed brief: journal + Paperclip + recent notes. What's moving, what needs you, what shipped. |
| **Journal** | Daily trail | `Vault/Journal/YYYY-MM-DD.md`, newest first, parsed into sections |
| **Notes** | Durable knowledge | `Vault/Notes/*.md` — search, reader, wikilinks, CriticMarkup rendering |
| **Work** | Execution | Paperclip issues / agents / activity / projects via the local API |
| **Memory** | Agent state | `clawd/MEMORY.md` index + daily memory files |
| **Ontology** | Meaning | jarvos-ontology spine (higher order → projects) |
| **Services** | The bundle | Health of every system jarvOS connects |

## Run

```bash
# in a browser
npm run serve            # http://127.0.0.1:4807

# as a desktop app
npm install              # first time only (pulls Electron)
npm run desktop
```

The Electron shell boots the server in-process; if a server is already running
on the port it just attaches to it.

## Design intent

Follows the Jarvis-page product correction from the Agent Control for Mac PRD:
this is the **plain-English interface to your autonomous work, memory, and
meaning system** — not runtime telemetry. Paperclip grounds work state, the
ontology grounds why it matters, the journal grounds the day.

UI inspiration: [Odysseus](https://github.com/pewdiepie-archdaemon/odysseus)
(PewDiePie's self-hosted AI workspace) — one calm sidebar workspace, local-first,
no telemetry, all assets vendored (fonts, markdown renderer, sanitizer).

## Architecture

```
server/            zero-dependency Node HTTP server
  config.js        loads config.json, expands ~
  today.js         composes the Today brief (deterministic, no LLM)
  adapters/
    journal.js     vault daily files -> parsed sections
    notes.js       vault notes -> list/search/read
    paperclip.js   local Paperclip API (board token from ~/.paperclip/auth.json)
    ontology.js    jarvos-ontology spine files
    memory.js      MEMORY.md + daily memory files
    health.js      service checks
static/            single-page UI, vanilla JS, vendored assets
electron/main.js   thin desktop shell
config.json        all paths/endpoints — edit to point at your own setup
```

## Trust & safety notes

- Binds to `127.0.0.1` only. Nothing leaves the machine.
- Paperclip agent records are field-whitelisted server-side so gateway tokens
  in `adapterConfig` never reach the browser.
- All rendered markdown is sanitized with DOMPurify (journal content is partly
  agent-written).
- Read-only: the app writes nothing to the vault, Paperclip, or memory.

## Known prototype limits

- No write actions yet (capture box, issue transitions, approvals are the
  obvious next step).
- The Today brief is deterministic composition, not an LLM synthesis — the
  Jarvis "what changed and why it matters" narrative is future work.
- Paperclip issue list is capped at 250 most recent issues.
