---
title: SUP-3835 Runtime Selection and Migration Rehearsal
issue: SUP-3835
date: 2026-08-26
status: passed
---

# SUP-3835 Runtime Selection and Migration Rehearsal

## Selected candidate

- GBrain release: `0.46.32.0`
- Source commit: `d11b7992d7085ada60505730f53bda7ab4df3313`
- CLI SHA-256: `9aef202fae34f150234a2885edde3b7c9fad290fc0229e4bee65635026b72451`
- Candidate state: isolated, owner-controlled, executable, and not group- or world-writable
- Candidate tests: 282 passed, 0 failed
- Installed runtime during rehearsal: unchanged at `0.46.29.0`
- Dirty source checkout: preserved and never selected as an execution source

The candidate carries the current release plus the three previously isolated local embedding repairs. It remains unselected until the reviewed jarvOS change is merged.

## Disposable migration receipt

The rehearsal used synthetic data only. Every run used an isolated `GBRAIN_HOME`, an authenticated Postgres cluster bound to `127.0.0.1`, an empty inherited environment, and `GBRAIN_SWEEP=0`. No private brain, harness configuration, provider credential, or Paperclip database was used.

Final provider-supported path:

1. Initialize a 1024-dimensional PGLite brain with the selected release.
2. Write two entity-scoped facts through the `remember` verb and one deterministic 1024-dimensional embedded fact through GBrain's engine interface.
3. Run `gbrain migrate --to supabase --url <redacted-loopback-url>`.
4. Verify three facts, a 1024-dimensional stored embedding, Postgres `halfvec(1024)`, and entity-scoped structured recall.
5. Run `gbrain migrate --to pglite --path <disposable-rollback-store>`.
6. Verify the same three facts, 1024-dimensional embedding, and structured recall from the restored PGLite brain.

Result: forward migration passed; reverse migration passed; temporary server, data, logs, credentials, and pgvector compatibility links were removed on every exit path.

## Provider and native-harness rehearsal

A second disposable Postgres run exercised the reviewed provider launcher and
the installed native CLI surfaces. The synthetic entity fact was recalled
through provider-native MCP; `get_brain_identity` reported Postgres; and the
tool catalog exposed `get_brain_identity`, `recall`, `remember`, `list_skills`,
and `get_skill`. `list_skills` discovered Skillify and `get_skill` resolved it
from GBrain's own skill tree. Receipts retain only capability and identity
outcomes, not the synthetic fact or Skillify body.

Native lifecycle results:

- Codex: `mcp add` -> `mcp get` -> `mcp remove`, with no database URL or
  credential in the isolated profile.
- Hermes: `mcp add` with the native tool-confirmation prompt -> `mcp test` ->
  `mcp remove`. The rehearsal explicitly rejected add-command exit status as
  proof after observing that a cancelled add and a missing-server test could
  return without a useful nonzero status.
- OpenClaw: `mcp add` -> `mcp probe --json` -> `mcp unset`, with 131
  provider-owned tools discovered and no database URL or credential in the
  isolated profile.

All three registrations used the same descriptor path and launcher. The
launcher stripped ambient database routing and forced `GBRAIN_SWEEP=0`; the
owner-only GBrain config held the loopback Postgres credential. The final
contract additionally pins GBrain's `skills/manifest.json` and
`skills/skillify/SKILL.md`, then supplies the verified tree through
`GBRAIN_SKILLS_DIR` so a neutral working directory cannot sever resolver
provenance. Candidate digests are:

- skill manifest: `32ec742721aa89c814edcdf17809c73a30dda0c20c4399e1239db10e8504c1c0`
- Skillify: `dca5c9d56bc81a5358e1c372939793033f77d5fed49d9572cbea83fe95d4d833`

Two compensation defects were found during rehearsal, before activation: zsh
did not split a scalar list of compatibility links, and `status` is a reserved
zsh parameter. The exact temporary listener and 43 compatibility symlinks were
removed immediately after each failed compensation, then cleanup was rewritten
with a zsh array and a non-reserved exit variable. Final cleanup proof reported
no listener, zero compatibility links, no configured disposable harness entry,
and the synthetic rehearsal root was moved to Trash. No private brain or
installed harness profile was involved.

## Postgres ownership boundary discovered by rehearsal

GBrain v0.46.32 requires a narrow two-role bootstrap:

- The database administrator creates the `vector` extension and the documented `auto_rls_on_create_table` event trigger. Event-trigger creation is superuser-only.
- The administrator transfers ownership of `auto_enable_rls()` to the GBrain runtime role so later GBrain hardening migrations can pin its `search_path`.
- The GBrain runtime role is a login role with `NOSUPERUSER`, `NOCREATEDB`, `NOCREATEROLE`, and `NOREPLICATION`, plus the provider-required `BYPASSRLS` capability.

The private-environment operator owns this one-time bootstrap and the Postgres lifecycle. jarvOS observes the resulting health and identity tuple; it does not become a database service supervisor.

## Rehearsal corrections retained as evidence

- A wrapper that called the migration function without configuring GBrain's AI gateway initialized the target with the wrong default embedding width. The real CLI configures the gateway before opening either engine and correctly created a 1024-dimensional target.
- Postgres intentionally stores the fact embedding as `halfvec(1024)` while PGLite uses `vector(1024)`. Continuity is defined by dimension, content, and recall behavior, not identical physical column types.
- The structured fact recall contract is entity/session/time scoped. A free-text `query` searches the page arm; the final fixture therefore used `recall <entity>`.
- `BYPASSRLS`, the event-trigger bootstrap, and the function-ownership handoff are required provider behavior and must appear in the activation/recovery runbook.

## Private schema incident and disposition

Before this final isolated rehearsal, a delegated diagnostic invoked `gbrain migrate --help` without an isolated `GBRAIN_HOME`. In this release, that CLI-only help path connects before rendering help and advanced the private PGLite schema from 141 to 142. Migration 142 resized `takes.embedding` to 1024 and clears existing take vectors.

A single read-only diagnostic against the exact private store reported zero stale or present take embeddings (`total_stale=0`, `would_embed=0`, `failures=0`). No fact, page, note, or journal content was deleted. The installed `0.46.29.0` runtime tolerates a schema newer than its own latest migration and reports no pending migration. No rollback was warranted; all further private GBrain mutation remains frozen until the reviewed activation stage.

## Host package state

- Homebrew `postgresql@17` `17.11` and `pgvector` `0.8.6` are installed.
- No Homebrew Postgres service is active.
- A default owner-only cluster directory was created by an accidental `brew postinstall postgresql@17`; it is not running and remains preserved pending explicit activation or durable disposition.
- Paperclip's separately managed embedded Postgres listener was not touched.
