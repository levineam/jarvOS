# jarvOS — Grok Bot Runtime

Grok Bot is an optional jarvOS runtime. The Obsidian-compatible **vault is
canonical**. Grok Bot has a **separate computer**. Native Grok memory, routines,
and CloudAgent stay host-owned. jarvOS does not clone the vault onto Grok Bot,
does not auto-ingest all chats, and does not expose `SendMessage` or CloudAgent
from this adapter.

This connector is **operator-supervised** and sits **outside conformance**. It
is not in `CANONICAL_HARNESS_IDS`, has no canonical-harness, skill or native
dispatch support, and has no live lifecycle coverage.

## Why remote HTTP, not stdio

`jarvos-mcp.js` is a stdio server that reads the vault on the machine where it
runs. Registering that stdio command on the Grok Bot disk hydrates **Grok Bot's
files** (the wrong machine), not the vault host. Do not register stdio MCP on
the Grok Bot disk. The Grok Bot client is only a **remote URL + bearer token**
pointing at an authenticated **Streamable HTTP** endpoint on the vault host
(JSON-RPC responses in the POST body, `Mcp-Session-Id` per `initialize`).

If the endpoint is unreachable, Grok Bot should fail open: continue the chat
without jarvOS context instead of pretending the local box is the vault.

## Scoped Grok interface

Grok Bot uses its own launcher, `runtimes/grok-bot/gateway.js`. It serves
exactly eight tools with host-owned, closed argument schemas:

| Tool | Effect |
| --- | --- |
| `jarvos_hydrate` | read |
| `jarvos_startup_brief` | read |
| `jarvos_projects_context` | read |
| `jarvos_recall` | read |
| `jarvos_journal_health` | read |
| `jarvos_session_thread_read` | read |
| `jarvos_create_note` | write (host stamps `source_personality: grok-bot`) |
| `jarvos_session_thread_write` | write (host stamps `host: grok-bot`, journal link) |

Unknown arguments are refused; attribution is stamped by the host after
validation. Prompts and every other tool are denied. The policy is fixed in the
launcher; `requiredTools` in `adapter.json` is only a declaration.

The general gateway `modules/jarvos-agent-context/scripts/jarvos-mcp-http.js`
run directly is **full-surface** (all registered tools, including writes and
control-plane). Do **not** reuse it, or its token, for this client. The Grok
launcher reads only Grok credentials and refuses a token file or value shared
with the generic or Muse gateway.

## Hydration (manual)

`grok-bot-http` uses **manual hydration**; `startupHydration` is unsupported
and there is no SessionStart hook. After connecting, call the `jarvos_hydrate`
tool. The legacy `boot_jarvos` prompt exists only on the general gateway; the
scoped endpoint denies prompts, so do not use it here.

## What's here

- `adapter.json` — public runtime declaration (not a canonical managed harness)
- `gateway.js` — scoped Grok launcher (fixed eight-tool policy)
- `setup.sh` — vault-host token preparation and read-only validation
- this README

## Stages (keep them separate)

1. **Preparation** (vault host): run `setup.sh`, configure the host.
2. **Credential provisioning**: give Grok Bot the token out of band.
3. **Public exposure**: TLS front (for example Tailscale Funnel) to loopback.
4. **Protected activation**: operator starts the launcher under a supervisor.
5. **Client qualification**: prove reads and writes end to end (below).

None of these happen implicitly; `setup.sh` performs only stage 1.

## 1. Preparation (vault host)

```bash
./runtimes/grok-bot/setup.sh
```

The script validates `JARVOS_GROK_MCP_HOST` / `JARVOS_GROK_MCP_PORT` before
touching any token, keeps an existing trusted owner-only regular token file
(backed up, never rotated or printed), creates a new `0600` token only if
absent (default `~/.jarvos/grok-bot-mcp.token`), then validates the result with
the launcher's own resolver without starting a server. It does not install a
daemon, service or Funnel.

Environment controls (Grok-only names):

- `JARVOS_GROK_MCP_TOKEN_FILE` — owner-only token file (preferred)
- `JARVOS_GROK_MCP_HOST` — bind host, default `127.0.0.1`
- `JARVOS_GROK_MCP_PORT` — required by the launcher; examples use `8767`
- `JARVOS_GROK_MCP_ALLOW_NON_LOOPBACK=1` — explicit opt-in; the bearer token
  would travel as cleartext HTTP unless TLS terminates in front. Not a default.

Safe host configuration: set `JARVOS_CONFIG_PATH` to this host's config that
names the canonical vault. The existing note/thread writer must already be
qualified on this host. Enforcement flags `JARVOS_REQUIRE_ROUTE_CAPABILITY`
and `JARVOS_REQUIRE_CANONICAL_VAULT` are forwarded to the child; route
secrets, caller capabilities and owner/module bindings are not. A host that
requires a route capability may therefore **fail closed** until a proper
adapter exists; do not disable enforcement to work around it.

Start (operator-supervised, manual):

```bash
export JARVOS_CONFIG_PATH=/ABS/PATH/TO/jarvos.config.json
export JARVOS_GROK_MCP_TOKEN_FILE="$HOME/.jarvos/grok-bot-mcp.token"
export JARVOS_GROK_MCP_PORT=8767
node runtimes/grok-bot/gateway.js
```

Missing or reused credentials fail closed (the process will not start).

## 2–3. Credential provisioning and public exposure

`http://127.0.0.1:8767/mcp` is reachable only **on the vault host**. Pick one:

1. **SSH tunnel** (token stays on loopback at both ends):

   ```bash
   ssh -N -L 8767:127.0.0.1:8767 user@vault-host
   ```

2. **Tailscale Funnel** (or another TLS reverse proxy) to the loopback launcher:

   ```bash
   tailscale funnel --bg http://127.0.0.1:8767
   tailscale funnel status
   ```

   Point Grok Bot at the HTTPS URL plus `/mcp` (for example
   `https://<vault-host>.<tailnet>.ts.net/mcp`) with
   `Authorization: Bearer <token>`. If the launcher dies, Funnel returns 502.

Provision the token to Grok Bot out of band; never paste it into transcripts.

## 4. Protected activation (supervised)

Ad-hoc shells exit with their session. Prefer a user LaunchAgent (macOS) or
equivalent supervisor with `KeepAlive`, running `node
/ABS/PATH/TO/jarvOS/runtimes/grok-bot/gateway.js` with
`JARVOS_GROK_MCP_TOKEN_FILE`, `JARVOS_GROK_MCP_HOST=127.0.0.1`,
`JARVOS_GROK_MCP_PORT=8767` and `JARVOS_CONFIG_PATH` in its environment. Load it
yourself (`launchctl bootstrap gui/$(id -u) <plist>`); nothing here installs it.

## Write timeouts

If `jarvos_create_note` or `jarvos_session_thread_write` times out, the result
is **outcome uncertain**: the write may or may not have landed. Do not retry
blindly; read back (`jarvos_session_thread_read`, `jarvos_recall`) first.
`jarvos_create_note` follows the vault mutation contract: Obsidian should be
open on the vault host so pending mutations can be acknowledged/reconciled.

## Choosing a machine

The Mac mini is the primary example vault host; a MacBook may be added later
only after it is qualified the same way. Each machine runs its own launcher and
is a separate native named connector in Grok Bot; the connector URL selects the
machine. There is no custom router and no silent cross-machine write fallback:
select the target explicitly. Every target must use the same canonical
session-thread id and storage destination.

## 5. Client qualification

Before relying on a target, pass a both-direction proof: Grok Bot writes a
fresh nonce with `jarvos_session_thread_write` and the vault host confirms it;
the host writes a nonce/test result Grok Bot then reads back with
`jarvos_session_thread_read`. Repeat per target. Public tests use fakes only
and are not live client conformance.

## Protocol versions

`initialize` accepts the dated allowlist (`2025-11-25`, `2025-06-18`,
`2025-03-26`, `2024-11-05`); the child negotiates a supported version and the
gateway pins it for the session. This is Streamable HTTP only: the legacy
2024 HTTP+SSE transport is not claimed, nor is live Grok client conformance.

## Intentional capture

When the user asks to save a note or idea through Grok Bot, use
`jarvos_create_note` via this endpoint. Do not raw-write vault Markdown on the
Grok Bot disk.

## Verification

```bash
node modules/jarvos-runtime-kit/scripts/jarvos-runtime-kit.js check grok-bot
```

No live Grok Bot session is required for public tests.
