# Journal Install Contract

jarvOS keeps a daily **journal** as its raw capture surface — the running log
your agents append to as they work. This document is the install-time contract
for that journal: where it lives, who is allowed to write it, and how to keep a
second tool from silently clobbering it.

It exists because of a real incident (SUP-2269): an Obsidian journaling plugin
was enabled on the same vault jarvOS journals into, the two writers fought over
the same dated files, and jarvOS journal content was overwritten with empty
stubs. The rules below — and the `jarvos doctor` checks that enforce them — are
the durable fix.

## Where the journal lives

The journal is a folder of dated Markdown files inside your Obsidian vault:

```
<vaultPath>/Journal/YYYY-MM-DD.md
```

- `vaultPath` is the value in your `jarvos.config.json`.
- The journal directory is `<vaultPath>/Journal` (override with the
  `JARVOS_JOURNAL_DIR` environment variable if you must).
- Each day is a single file named by ISO date.

## The single-writer rule

**jarvOS must be the only automated writer of the `Journal/` folder.**

You can read, hand-edit, and link to journal files freely in Obsidian. What you
must **not** do is point a *second automation* at the same folder, because both
tools assume they own the dated file and will overwrite each other:

- ❌ Do **not** enable the Obsidian **`journals`** community plugin on this vault.
- ❌ Do **not** enable the Obsidian core **Daily notes** plugin with its *New file
  location* set to `Journal/` (or to the vault root, which also lands daily notes
  on top of the journal).
- ❌ Do **not** point the **Periodic Notes** community plugin's daily notes at
  `Journal/` (or the vault root).
- ✅ It is fine to keep Daily notes / Periodic Notes / journaling plugins enabled if
  they write to a **different** folder that does not overlap `Journal/`.

If you want Obsidian's daily-note convenience, give it its own folder (for
example `Daily/`) and leave `Journal/` to jarvOS.

## How `jarvos doctor` enforces it

Two checks in the public `jarvos doctor` (the `minimal` profile runs both) catch
the failure modes before they cost you journal content:

| Check | Fails when | Why it matters |
| --- | --- | --- |
| `vault-path-stale` | the configured `vaultPath` root no longer exists | a moved/renamed vault means journal writes silently land in the wrong place |
| `journal-conflict` | the `journals` plugin is enabled, or core Daily notes / Periodic Notes write into a folder overlapping `Journal/` | a second writer can overwrite jarvOS journal entries with stubs (SUP-2269) |

Run it after install and any time you change vault or Obsidian settings:

```bash
jarvos doctor --profile minimal --workspace /path/to/jarvos-workspace
```

A clean vault reports:

```text
PASS vault-path-stale — vault path freshness (...)
PASS journal-conflict — journal writer conflict (jarvOS is the single journal writer)
```

If `journal-conflict` fails, the detail line names the offending plugin. Disable
it (or repoint it at a non-overlapping folder), then re-run `jarvos doctor` to
confirm `READY`.

## Recovering from a conflict

If a second writer has already stubbed out journal entries:

1. Disable the conflicting Obsidian plugin (`journals`, or Daily notes pointed at
   `Journal/`).
2. Restore the affected dated files from Obsidian file recovery, your vault's
   version history, or a backup.
3. Re-run `jarvos doctor`; both checks should pass.

The core path layer also refuses a stale vault path at write time
(`assertNotStaleVaultPath`), so a misconfigured `vaultPath` fails loudly rather
than writing journal entries into a dead location.
