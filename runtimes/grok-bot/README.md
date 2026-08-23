# jarvOS — Grok Bot Runtime

Grok Bot is an optional jarvOS runtime. The Obsidian-compatible **vault is
canonical**. Grok Bot has a **separate computer**. Native Grok memory, routines,
and CloudAgent stay host-owned. jarvOS does not clone the vault onto Grok Bot,
does not auto-ingest all chats, and does not expose `SendMessage` or CloudAgent
from this adapter.

## Why remote HTTP, not stdio

`jarvos-mcp.js` is a stdio server that reads the vault on the machine where it
runs. Registering that stdio command on the Grok Bot disk hydrates **Grok Bot's
files**, not the vault host. v1 is an authenticated HTTP/SSE connector **on the
vault host**. The Grok Bot client is only a **URL + token**.

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
- prints the loopback HTTP/SSE URL and how to start the gateway
- tells you to paste **only** that URL and token into Grok Bot

Start the gateway on the vault host:

```bash
export JARVOS_MCP_HTTP_TOKEN_FILE="$HOME/.jarvos/grok-bot-mcp.token"
node modules/jarvos-agent-context/scripts/jarvos-mcp-http.js
```

Defaults: bind `127.0.0.1:8765`. Missing token fails closed (the process will
not start). Non-loopback bind requires an explicit allow flag.

### Grok Bot client

In Grok Bot, add a remote MCP server:

- URL: `http://127.0.0.1:8765/mcp` (or your tunneled vault-host URL)
- Auth: `Authorization: Bearer <token>`

Do **not** add `node .../jarvos-mcp.js` as a stdio server on Grok Bot.

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
