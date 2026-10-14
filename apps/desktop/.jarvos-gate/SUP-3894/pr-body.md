## Summary

Compliant coding-gate replay of the jarvOS voice-mode particle avatar for SUP-3894.

- Issue-named branch replay from verified base `b4113ed` (not unmanaged PR #4)
- Lightweight PixiJS 2D particle puppet with listening / thinking / speaking states
- Gate fixes: speech-energy latch across interrupt, gesture schedule reset, destroy-during-init race
- Gate receipts under `.jarvos-gate/SUP-3894/`

## Provenance

Unmanaged source PR #4 (`0443147`) is **provenance only** and must not be merged. This PR is the merge path.

## Verification

- `npm test` → 25/25
- `npm run smoke` → pass
- Clawpatch advisory + CE review-of-record → Ready for merge
- Goal-alignment → aligned

## Demo

```bash
npm run serve
# Chat → Voice avatar
```

## Test plan

- [ ] Open Voice avatar panel; confirm abstract point-light figure
- [ ] Cycle listening / thinking / speaking; interrupt returns to listening
- [ ] Speech energy drives mouth cluster; gestures stay restrained
- [ ] Hide panel; confirm ticker/work stops
- [ ] Confirm PR #4 remains closed / not merged
