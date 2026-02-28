# TOOLS.md - Local Notes

This file is the **source of truth for operational policy** in your workspace. Add rules, configs, and patterns here as you discover what works. AGENTS.md handles behavior — this file handles mechanics.

---

## Subagent Spawn Policy (HARD)

- **Fail-closed gate:** if fulfilling a main-chat request requires any tool call, announce + spawn a subagent.
- **Pre-spawn ritual:**
  ```
  Spawning a subagent
  Why: <one-line reason>
  You'll get: <one-line deliverable>
  ETA: <rough time>
  ```
- **Inline allowlist:** only plain conversation, quick clarifications, and model/status switches.

---

## Model Routing

Configure model names here based on your provider:

| Task Type | Recommended Tier |
|-----------|-----------------|
| Casual chat, quick lookups | Low (fast, cheap) |
| Coding, analysis, writing drafts | Medium |
| Complex reasoning, high-stakes decisions | High |
| Architecture decisions, novel problems | Ultra (sparingly) |

Add specific model IDs once you know what your provider calls them.

---

## Approved Acronyms

Default: no acronyms in user-facing chat unless listed here.

*(none yet — add as needed)*

---

## Quiet Hours Policy

- **Outreach quiet zone:** [20:00–05:00 {{TIMEZONE}}] — no notifications unless urgent
- **Autonomous work:** continues 24/7, even during quiet hours
- **Nudge cooldown:** max 1 nudge per 60 minutes during active hours

---

## Vault & Path Config

- **Vault path:** `{{VAULT_PATH}}`
- **Workspace path:** `{{WORKSPACE_PATH}}`
- **Timezone:** `{{TIMEZONE}}`

---

## Local Rules & Patterns

*Add workspace-specific rules below as you discover them.*

*(none yet)*

---

*Keep this file lean. Split into module files if it grows beyond ~3K chars.*
