# jarvOS — Grok Bot Runtime

Grok Bot is an optional jarvOS runtime. The Obsidian-compatible **vault is
canonical**. Grok Bot has a **separate computer**. Native Grok memory, routines,
and CloudAgent stay host-owned. jarvOS does not clone the vault onto Grok Bot,
does not auto-ingest all chats, and does not expose `SendMessage` or CloudAgent
from this adapter.

This connector is **operator-supervised** and sits **outside conformance**. It
is not in `CANONICAL_HARNESS_IDS` and has no live lifecycle coverage.

## Why remote HTTP, not stdio

`jarvos-mcp.js` is a stdio server that reads the vault on the machine where it
runs. Registering that stdio command on the Grok Bot disk hydrates **Grok Bot's
files**, not the vault host. v1 is an authenticated **Streamable HTTP** connector
**on the vault host** (JSON-RPC responses in the POST body, `Mcp-Session-Id` per
client). The Grok Bot client is only a **URL + token**.

If the vault-host connector is unreachable, Grok Bot should fail open: continue
the chat without jarvOS context instead of pretending the local box is the vault.

## Checked-in adapter status

`grok-bot-http` uses **manual hydration**. `startupHydration` is unsupported.

When the remote connector is up:

1. Use the MCP prompt `boot_jarvos`, or
2. Call the `jarvos_hydrate` tool.

Do not expect a SessionStart hook on Grok Bot.

## What's here

- `adapter.json` — public runtime declaration (not a canonical managed harness)
- `setup.sh` — vault-host token + HTTP gateway helper
- this README

Skill projection, CloudAgent-as-coding-host, and bidirectional memory sync are
out of scope.

## Setup (vault host)

Run from a jarvOS checkout **on the machine that holds the vault**:

```bash
./runtimes/grok-bot/setup.sh
```

The script:

- refuses to write a stdio MCP command as if the vault lived on Grok Bot
- creates an owner-only bearer token on the vault host (backed up first)
- prints how to start the gateway and where the token file lives
- does **not** print the live bearer token

Start the gateway on the vault host:

```bash
export JARVOS_MCP_HTTP_TOKEN_FILE="$HOME/.jarvos/grok-bot-mcp.token"
node modules/jarvos-agent-context/scripts/jarvos-mcp-http.js
```

Defaults: bind `127.0.0.1:8765`. Missing token fails closed (the process will
not start). The gateway speaks Streamable HTTP: POST `/mcp`, JSON response in
the body, `Mcp-Session-Id` issued on `initialize`. Each session gets its own
`jarvos-mcp.js` child.

### Reaching Grok Bot (loopback is the vault host)

`http://127.0.0.1:8765/mcp` is reachable only **on the vault host**. Grok Bot is
a different computer; its loopback is not this process. Pick one:

1. **SSH tunnel** (token stays on loopback at both ends):

   ```bash
   ssh -N -L 8765:127.0.0.1:8765 user@vault-host
   ```

   Then point Grok Bot at `http://127.0.0.1:8765/mcp` **on the machine where
   that tunnel is listening**.

2. **Non-loopback bind** (explicit, and the bearer token is cleartext HTTP
   unless you terminate TLS in front):

   ```bash
   export JARVOS_MCP_HTTP_HOST=0.0.0.0
   export JARVOS_MCP_HTTP_ALLOW_NON_LOOPBACK=1
   ```

   Put a TLS reverse proxy in front before exposing this beyond a trusted LAN.

`JARVOS_MCP_HTTP_TOKEN_FILE` may override the default token path; treat that
file as secret and do not paste it into agent transcripts.

### Grok Bot client

In Grok Bot, add a remote MCP server using **Streamable HTTP**:

- URL: the **tunneled or TLS** vault-host URL (not the vault host's loopback
  unless a tunnel is listening on the Grok Bot side)
- Auth: `Authorization: Bearer <token from the token file>`

Do **not** add `node .../jarvos-mcp.js` as a stdio server on Grok Bot.

The bearer token grants the **full MCP surface** of `jarvos-mcp.js` (all
registered tools, including writes and control-plane), not only the five
`requiredTools` listed in `adapter.json`. Those names are the hydration
contract, not a gateway allowlist.

If the URL does not respond, leave jarvOS unhydrated and continue. That is the
supported fail-open path.

## Intentional capture

When the user asks to save a note or idea through Grok Bot, use the shared
capture path with source `grok-bot`. Do not raw-write vault Markdown on the Grok
Bot disk.

## Verification

```bash
node modules/jarvos-runtime-kit/scripts/jarvos-runtime-kit.js check grok-bot
```

No live Grok Bot session is required for public tests.
