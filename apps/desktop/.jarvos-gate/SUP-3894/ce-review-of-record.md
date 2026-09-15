# CE Review-of-Record — SUP-3894

**Issue:** Compliant replay of jarvos-desktop voice-mode particle avatar  
**Branch:** `SUP-3894/voice-mode-particle-avatar`  
**Base:** `origin/master` (`b4113ed7d3559faebe461b09670be3faa3a79314`)  
**Reviewed head (pre-fix):** `29d83b0b011f652838991a157cefaa89d8dd3971`  
**Fix commit:** see `submission-receipt.md` for final SHA  
**Reviewer:** grok-4.6 (high effort)  
**Scope:** `chat-src/`, `test/`, minimal `package.json` / `README.md` integration. `static/chat/*` treated as generated (production rebuild of `VoiceAvatarPanel.js` included with fixes).

## Verdict

**Ready for merge** (after applied P1/P2 fixes + regression tests)

Core AvatarController surface, particle budgets, FPS caps, hidden/document-hidden ticker pause, interrupt→listening timing, and chat decoupling are in good shape. The speech-energy latch bug and auto-gesture scheduling bug identified in the first pass are fixed and covered by `test/avatar-model.test.js`.

## Actionable findings (resolved)

### P1 — Speech energy latch cleared on interrupt; UI value not re-applied — FIXED

- Stopped clearing `speechEnergyTarget` on `interrupted`; snap only smoothed `speechEnergy` to 0.
- `VoiceAvatarPanel.chooseState` re-asserts `setSpeechEnergy` when entering `speaking`.
- Unit test: energy → interrupt → listening → speaking keeps latch / gesture schedule.

### P2 — Auto-gesture `nextGestureAt` not reset on speaking re-entry — FIXED

- `setAvatarState(..., 'speaking')` now resets `nextGestureAt` to `2.8`.
- Covered by the same regression test.

### Clawpatch medium — destroy() during async init — FIXED

- `init()` returns early if already destroyed; post-`app.init` checks `destroyed` and teardowns.
- `destroy()` delegates to `teardownRenderer()` and clears texture/host children.

## Checklist notes

| Check | Result |
| --- | --- |
| AvatarController API | Present and exported; README matches |
| Hidden pauses RAF | Ticker stop + canvas hidden |
| Interrupt → listening | ~0.28s auto-return; tested |
| Speech clamp/smooth + latch | Tested including interrupt latch |
| Perf budgets | Normal 1450+90 @ 30fps; low 500+36 @ 24fps |
| Chat coupling | Lazy lab panel; voice pipeline not hard-wired |
| Security | No eval / path IO in new avatar code |

## Residual risks

- No DOM/Pixi integration tests for ticker/destroy races.
- Deferred clawpatch mediums on config tenant IDs, smoke hang, and Vite stale-bundle verification remain for follow-up outside this replay.
- `WebAudioSpeechEnergy` helper remains unused by the panel (intentional).

## One-paragraph summary (Paperclip receipt)

SUP-3894’s particle avatar replay is merge-ready after fixing the speech-energy latch, speaking-turn gesture schedule, and destroy-during-init race, with unit coverage for the latch/gesture regressions. AvatarController API, state machine, interrupt timing, particle/FPS budgets, hidden ticker pause, and chat-lab decoupling check out. Pre-existing config/smoke verification findings are deferred as out of replay scope.
