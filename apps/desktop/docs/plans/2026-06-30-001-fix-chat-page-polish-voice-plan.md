---
title: Chat Page Polish + Voice Wiring - Plan
type: fix
date: 2026-06-30
topic: chat-page-polish-voice
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: ce-plan-bootstrap
execution: code
---

<!-- markdownlint-disable-next-line MD025 -->
# Chat Page Polish + Voice Wiring - Plan

## Goal Capsule

- **Objective:** Fix two layout problems on the merged Chat page and make voice dictation actually work via a local whisper.cpp backend.
- **Product authority:** Andrew (interactive iteration on the shipped Chat Agent Page).
- **Open blockers:** None. Backend chosen: whisper.cpp (confirmed 2026-06-30). No Whisper model is currently downloaded, so a one-time ~140 MB model fetch is part of local setup.

---

## Product Contract

### Summary

Three post-ship fixes to the Chat page: (1) the composer no longer stretches to fill the window, (2) the input grows from one line as you type like Claude/ChatGPT, and (3) the microphone button works by transcribing locally with whisper.cpp instead of sitting disabled.

### Problem Frame

The Chat Agent Page shipped, but with a key configured the composer becomes "comically tall," the textarea isn't ergonomic, and the mic button is permanently disabled because no local Whisper backend exists. The first two are CSS/layout bugs; the third is an unmet dependency, not a code defect — the transcribe endpoint is built and waiting for a configured whisper.cpp binary + model.

### Requirements

- R1. With an OpenAI key set, the composer renders at its natural (small) height, not stretched to fill leftover vertical space; the message thread takes the flexible space instead.
- R2. The composer textarea starts at one line and grows as the user types, up to a capped height, then scrolls — matching modern chat UIs.
- R3. The microphone button is enabled and functional: pressing it records, transcribes the audio locally via whisper.cpp, and inserts the text into the composer.
- R4. When whisper.cpp is not configured/installed, voice still degrades gracefully (button disabled with a clear reason) — the existing behavior is preserved as the fallback.
- R5. Repo defaults stay portable: no machine-specific absolute paths are committed; the local binary/model are referenced by PATH name and a `~`-expanded path.

### Success Criteria

- The Chat page looks correct with a key set (composer compact, thread scrolls) and with no key (banner shows, composer still compact).
- Dictation produces accurate text in the composer for a normal spoken sentence, end to end, in the running Electron app.
- The other six pages and the rest of the chat feature are untouched.

### Scope Boundaries

- **In scope:** the composer layout, textarea sizing, and the voice transcription path (code + local setup).
- **Out of scope:** the assistant-ui migration the original plan named (the shipped UI is custom — not revisiting that here), agent/tool logic, model/provider changes, realtime voice.

### Deferred to Follow-Up Work

- Configurable model size in the UI (base.en is the fixed default for now).
- Streaming/partial transcription and non-English models.

---

## Planning Contract

### Key Technical Decisions

- KTD1. **Thread flexes, composer is natural height.** Replace the positional grid-row scheme in `.chat-main` (which mis-assigns the `1fr` track to the composer when the optional no-key banner is absent) with a layout where the **thread** is the single flexible region and the composer always sizes to content — robust whether or not the banner renders. A flex column with the thread as the growing child is the simplest robust form.
- KTD2. **Auto-grow the textarea.** Start at one row; grow to a max height then scroll. Prefer CSS `field-sizing: content` (supported in the app's recent Electron/Chromium) with a `max-height`; fall back to a small JS input handler (reset to `auto`, set to `scrollHeight`, cap) if `field-sizing` proves unreliable.
- KTD3. **whisper.cpp via the existing spawn contract.** Keep the shipped `transcribe` endpoint's "spawn a binary, read its text" shape. Config points `whisper.binary` at the PATH name `whisper-cli` (Homebrew `whisper-cpp`) and `whisper.model` at a `~`-expanded model path. The availability check (`binary && model && both exist`) and graceful-disable path are unchanged.
- KTD4. **Convert webm → 16 kHz mono WAV before whisper.cpp.** The mic posts `audio/webm` (Opus); whisper.cpp's CLI needs PCM WAV. Add an `ffmpeg` transcode step to the endpoint's temp-file handling. `ffmpeg` becomes a voice dependency alongside whisper.cpp.
- KTD5. **Local install is an operator step, not a commit.** Installing `whisper-cpp`/`ffmpeg` and downloading `ggml-base.en.bin` happens on this machine; only portable defaults (PATH name + `~` path) are committed. See Operational Notes.

### Assumptions

- The app's Electron build is recent enough for `field-sizing: content`; the JS fallback covers the case if not.
- `whisper-cli` is the binary Homebrew's `whisper-cpp` installs and it accepts `-m <model> -f <wav>` with transcription available on stdout (verified at implementation; `-nt`/`-otxt` handling settled there).
- A 16 kHz mono WAV is acceptable input quality for dictation accuracy with `base.en`.

---

## Implementation Units

### U1. Composer no longer stretches

- **Goal:** Fix the "comically tall" composer so the thread takes the flexible space.
- **Requirements:** R1.
- **Dependencies:** none.
- **Files:** `chat-src/styles.css` (and `chat-src/main.tsx` only if a wrapper element is needed).
- **Approach:** Rework `.chat-main` so the message thread is the one flexible region and the composer is natural height regardless of whether the no-key banner is present (flex column with `thread { flex: 1; min-height: 0 }`, or explicit grid-row placement). Remove the dependence on a fixed four-track row template.
- **Patterns to follow:** the existing `.chat-shell`/`.chat-main` layout in `chat-src/styles.css`.
- **Test scenarios:** `Test expectation: none -- pure layout; verified visually.` Manual: with a key set the composer is compact and the thread scrolls; with no key the banner shows and the composer is still compact; resizing the window keeps the composer pinned to its natural height.
- **Verification:** In the running app, the composer is a normal-height input in both key states.

### U2. Textarea auto-grows

- **Goal:** The input starts at one line and grows with content, capped.
- **Requirements:** R2.
- **Dependencies:** U1.
- **Files:** `chat-src/styles.css`, `chat-src/main.tsx` (only if the JS fallback is used).
- **Approach:** Apply `field-sizing: content` with the existing `max-height` cap and `rows={1}`; if that doesn't behave in this Electron build, add a minimal input handler that sets height from `scrollHeight` up to the cap. No change to submit/Enter behavior.
- **Patterns to follow:** the current `.composer textarea` rules and the `onKeyDown` submit handler in `chat-src/main.tsx`.
- **Test scenarios:** `Test expectation: none -- UI sizing; verified visually.` Manual: empty input is one line; typing several wrapped lines grows the box to the cap then scrolls; clearing returns it to one line; Enter still submits, Shift+Enter still newlines.
- **Verification:** Typing grows the box smoothly to the cap and no further.

### U3. Wire the transcribe endpoint to whisper.cpp

- **Goal:** Make `/api/transcribe` actually transcribe via whisper.cpp, including audio conversion, and set portable config defaults.
- **Requirements:** R3, R4, R5.
- **Dependencies:** none (code); the model/binary presence is satisfied by Operational Notes for live use.
- **Files:** `server/agent/transcribe.js`, `config.json`, `test/chat-agent.test.js`.
- **Approach:** Before spawning whisper.cpp, transcode the uploaded `audio/webm` temp file to 16 kHz mono WAV with `ffmpeg`, then pass the WAV to `whisper-cli`. Parse the transcription from whisper-cli's output (settle `-nt`/stdout vs `-otxt` file at implementation). Set `config.json` `whisper.binary` to `whisper-cli` and `whisper.model` to a `~`-expanded path (e.g. `~/.cache/whisper.cpp/ggml-base.en.bin`); the loader already expands `~`. Keep the availability gate and the structured "unavailable" response unchanged so R4 holds.
- **Patterns to follow:** the existing spawn/temp-file logic in `server/agent/transcribe.js`; the `~` expansion in `server/config.js`; existing transcribe tests in `test/chat-agent.test.js`.
- **Test scenarios:**
  - `Covers R4.` With `binary`/`model` empty (or missing on disk), `/api/transcribe` returns the structured unavailable response and the availability check reports `available: false` — no spawn attempted.
  - `Covers R3.` With a stubbed/fake binary configured and present, a posted audio blob triggers the ffmpeg→whisper spawn chain and the endpoint returns `{ text }` parsed from the binary's output.
  - Edge: an empty or non-audio upload is rejected with a clear error, not a hang.
  - Error: ffmpeg or whisper exiting non-zero surfaces a 5xx with the stderr reason, not a silent empty success.
- **Verification:** Unit tests pass with a stubbed binary; in the live app (after Operational Notes setup) a spoken sentence returns accurate text in the composer.

---

## Operational Notes — local whisper.cpp setup (this machine)

Not a code commit; run on this Mac so live voice works. Portable config defaults from U3 reference these by PATH name and `~` path.

1. Install the backend + audio tool: `brew install whisper-cpp ffmpeg` (provides `whisper-cli`).
2. Download the model once (~140 MB) to the `~`-path U3 points at, e.g. `ggml-base.en.bin` into `~/.cache/whisper.cpp/`.
3. Confirm `whisper-cli` is on PATH and the model file exists, then restart the app; `/api/settings` should report `voice.available: true` and the mic button enables.

---

## Verification Contract

| Gate | Command | Applies to | Done signal |
|---|---|---|---|
| Build | `npm run build` | U1, U2, U3 | Chat island builds clean |
| Unit tests | `npm test` | U3 | transcribe availability/spawn/error tests pass |
| Browser run | `npm run serve` → `http://127.0.0.1:4807` | U1, U2 | composer compact in both key states; textarea auto-grows |
| Desktop run | `npm run desktop` | R3 | after local setup, dictation inserts accurate text |

---

## Definition of Done

- R1–R5 hold; the composer is compact, the textarea auto-grows, and dictation works end to end after the one-time local setup.
- Voice still degrades gracefully when whisper.cpp is absent (R4), verified by a unit test.
- No machine-specific absolute paths committed (R5); the six other pages and the agent/tool logic are unchanged.
- Build and unit gates pass; U1/U2 verified visually, U3 verified live.

---

## Risks

- **whisper-cli I/O specifics.** Exact flags for clean text (timestamps off) and whether to read stdout vs the `-otxt` file vary by whisper.cpp version — settle by running the installed binary during U3, not by guessing.
- **ffmpeg dependency.** Voice now needs ffmpeg too; if absent, transcription fails. Mitigate by treating ffmpeg like whisper.cpp in the availability/disable path (optional follow-up) and documenting it in Operational Notes.
- **`field-sizing` support.** If the Electron build doesn't honor it, the JS fallback in U2 covers the behavior.

---

## Open Questions (deferred to implementation)

- Whether to extend the availability gate to also check for `ffmpeg` (so the mic disables cleanly when only ffmpeg is missing).
- Exact `whisper-cli` invocation/output parsing for the installed version.
