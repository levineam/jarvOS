# Clawpatch and ClawSweeper Setup

This repository uses clawpatch as a local semantic review tool. ClawSweeper is
installed from source as an external maintenance tool until it has a published
package.

## Local Tooling

- Node.js: 22 or newer for clawpatch, 24 or newer for ClawSweeper.
- Codex CLI: required by clawpatch's default provider.
- clawpatch: installed as a dev dependency at `clawpatch@0.2.0`.
- ClawSweeper: clone `https://github.com/openclaw/clawsweeper` and build it.
  The upstream repo declares `pnpm@10.33.2`; the SUP-1780 bootstrap also
  verified `npm install && npm run build`.

For this bootstrap, ClawSweeper was cloned to:

```text
/Users/andrew/clawd-worktrees/SUP-1780-clawsweeper
```

## Commands

Run clawpatch through the repository wrapper so every future workflow inherits
the same kill switch:

```bash
npm run clawpatch:doctor
npm run clawpatch:map
npm run clawpatch:status
npm run clawpatch:review:dry-run
```

Set `JARVOS_DISABLE_CLAWPATCH=1` to skip all clawpatch phases:

```bash
JARVOS_DISABLE_CLAWPATCH=1 npm run clawpatch:doctor
```

Future Paperclip workflow phases should call `npm run clawpatch -- <command>`
instead of invoking `clawpatch` directly.

## State Convention

Commit only portable setup files:

- `.clawpatch/config.json`
- `.clawpatch/project.json`

Do not commit generated runtime state:

- `.clawpatch/features/`
- `.clawpatch/findings/`
- `.clawpatch/locks/`
- `.clawpatch/patches/`
- `.clawpatch/reports/`
- `.clawpatch/runs/`

The feature map is per checkout. Any pr-autopilot clone or temporary worktree
that wants clawpatch review must run `npm install` and `npm run clawpatch:map`
before review.

## Initial Bootstrap Result

The first map run detected 6 heuristic features in jarvOS. `npm run
clawpatch:status` should report mapped features and zero active locks before
workflow integration continues.

## Upstream Contribution Policy

jarvOS should stay a configuration consumer, not a permanent fork. Bugs,
missing mapper support, inaccurate findings, and reusable config patterns found
during jarvOS integration should be reported or contributed upstream to
`openclaw/clawpatch` or `openclaw/clawsweeper`.
