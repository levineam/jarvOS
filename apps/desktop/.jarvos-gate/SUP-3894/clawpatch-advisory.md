# Clawpatch advisory — SUP-3894

**Branch:** `SUP-3894/voice-mode-particle-avatar`  
**Base:** `origin/master` (`b4113ed7d3559faebe461b09670be3faa3a79314`)  
**Review head (pre-fix):** `29d83b0b011f652838991a157cefaa89d8dd3971`  
**Run:** direct `clawpatch review --since origin/master --limit 5 --jobs 2` (`20260903T015910-2f077d`)  
**Note:** `scripts/post-subagent-clawpatch-advisory.js` timed out at 120s during map agent phase; map+review were completed directly with the local clawpatch workflow and recorded here.

## Verdict

**Advisory complete — no critical findings. In-scope avatar finding fixed; pre-existing medium/low findings deferred.**

## Findings triage

| ID | Sev | Decision |
| --- | --- | --- |
| `fnd_sig-feat-library-259c94fd7c-b659_877a42a09d` destroy() init race | medium | **Fixed** in `ParticleAvatar.init/destroy` (`destroyed` guard + post-init teardown) |
| `fnd_sig-feat-config-5a7caf737f-c827f_0b5de651de` stale Vite bundle vs tests | medium | **Deferred** — pre-existing verification gap; out of avatar replay scope |
| `fnd_sig-feat-config-5a7caf737f-e8147_66c20cf4be` checked-in Paperclip tenant IDs | medium | **Deferred** — pre-existing config concern; out of avatar replay scope |
| `fnd_sig-feat-library-710c9f5545-d189_b193e7a352` smoke HTTP hang | medium | **Deferred** — pre-existing smoke harness; out of avatar replay scope |
| `fnd_sig-feat-library-710c9f5545-f2b8_11a89e3bbe` model assertion separator | low | **Deferred** — pre-existing test assertion nit |

## Evidence paths

- `.clawpatch/runs/20260903T015910-2f077d.json`
- `.clawpatch/reports/20260903T015910-2f077d.md`
- Local advisory skip artifact (timeout): `.clawpatch/runs/advisory-latest.json` (`map_failed` from 120s script timeout; superseded by direct review above)
