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
| **Chat** | Interactive agent | Server-side AI SDK agent over local jarvOS tools; write actions require approval |
| **Today** | Control room | Composed brief: journal + Paperclip + recent notes. What's moving, what needs you, what shipped. |
| **Journal** | Daily trail | `Vault/Journal/YYYY-MM-DD.md`, newest first, parsed into sections |
| **Notes** | Durable knowledge | `Vault/Notes/*.md` — search, reader, wikilinks, CriticMarkup rendering |
| **Projects** | Outcomes | Host-authorized canonical projects, definitions of done and explicitly partial provider evidence |
| **Memory** | Deferred | Not part of this Desktop slice; underlying data is preserved |
| **Ontology** | Meaning | jarvos-ontology spine (higher order → projects) |
| **System** | Operating health | Published Doctor observations with freshness and lightweight connection checks |

## Run

```bash
# in a browser
npm run serve            # http://127.0.0.1:4807

# as a desktop app
npm install              # first time only (pulls Electron)
npm run desktop

# verify
npm run build
npm test
npm run smoke
```

The Electron shell boots the server in-process; if a server is already running
on the port it just attaches to it.

### Host bindings and observation freshness

Set `projectsContext.contextModule` in `config.json`, or the host-local
`JARVOS_DESKTOP_PROJECTS_CONTEXT_MODULE` environment variable, to the installed
jarvOS agent-context entry point exporting `readProjectsContext`. Desktop requests
the `orientation` profile; the host enforces its admitted scope and capabilities.
It does not read the raw registry or use automation's stricter freshness adapter.
Stale supporting providers remain visible as stale alongside canonical definitions.
Unverified completion evidence and next steps stay unavailable.

System reads owner-published `.jarvos/health-modules` snapshots using the public
jarvOS validator. Page/API reads never run Doctor, model probes or repairs. A
configured public `systemDoctor.receiptFile` additionally requires matching host
and profile plus `observedAt`/`validUntil`; invalid files fail closed. Missing or
expired observations never imply health. The view refreshes every 30 seconds
while visible, with single-flight reads and failure backoff. This rereads
observations; publishing new evidence remains the existing producer owner's job,
not a Desktop scheduler. Old `#/services` links redirect to `#/system`.

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
  agent/           AI SDK ToolLoopAgent, tools, credentials, transcription
  config.js        loads config.json, expands ~
  today.js         composes the Today brief (deterministic, no LLM)
  adapters/
    journal.js     vault daily files -> parsed sections
    notes.js       vault notes -> list/search/read
    paperclip.js   local Paperclip API (board token from ~/.paperclip/auth.json)
    ontology.js    jarvos-ontology spine files
    memory.js      MEMORY.md + daily memory files
    health.js      service checks
    system-doctor.js  public jarvos-system-doctor-report/v1 compact scoreboard (no probes; facts/v2 eleven-row Memory)
static/            single-page UI, vanilla JS, vendored assets
  chat/            Vite-built React chat island
chat-src/          Chat source (React + AI SDK useChat)
electron/main.js   thin desktop shell
config.json        all paths/endpoints — edit to point at your own setup
```

## Trust & safety notes

- Binds to `127.0.0.1` only. Nothing leaves the machine.
- Paperclip agent records are field-whitelisted server-side so gateway tokens
  in `adapterConfig` never reach the browser.
- All rendered markdown is sanitized with DOMPurify (journal content is partly
  agent-written).
- The Chat agent keeps model calls and the OpenAI key server-side. In Electron,
  saved keys are encrypted with `safeStorage`; in browser serve mode use
  `OPENAI_API_KEY`.
- Read tools run automatically. Creating notes, appending journal entries,
  mutating Paperclip, and dispatching OpenClaw work are approval-gated before
  execution.
- Vault writes are additive only in v1: new notes or appended journal bullets.

## Known prototype limits

- Voice dictation requires a configured local whisper.cpp binary and model in
  `config.json`; when absent, text chat still works.
- The **Voice avatar** button opens the particle-avatar lab in the existing Chat
  view. It exposes every lifecycle state, speech energy, four gestures, reduced
  motion, low-performance mode, and live frame timing. Run `npm run build`, then
  `npm run serve` and open `http://127.0.0.1:4807/#/chat` to use it.
- The Chat bundle is intentionally isolated from the vanilla pages, but it is a
  larger React/AI island and can be code-split later.
- The Today brief is deterministic composition, not an LLM synthesis — the
  Jarvis "what changed and why it matters" narrative is future work.
- Paperclip issue list is capped at 250 most recent issues.

### Voice avatar integration

`chat-src/avatar/ParticleAvatar.ts` exports the renderer/controller boundary:
`setState`, `setSpeechEnergy`, `setReducedMotion`, and `destroy`. The current
dictation lifecycle maps recording to `listening` and transcription to
`thinking`. When voice playback is added, connect its `AnalyserNode` to
`WebAudioSpeechEnergy` and feed the sampled value to `setSpeechEnergy` while the
avatar is `speaking`; the renderer deliberately owns no audio or agent logic.
