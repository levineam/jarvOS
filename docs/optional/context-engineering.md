# Context Engineering — Optional Skill Pack

> **⚠️ OPTIONAL — Not part of the default jarvOS setup.**
>
> The default jarvOS configuration handles most use cases well. This optional skill pack becomes valuable when you're running multi-agent workflows, experiencing context degradation, or optimizing for token efficiency at scale.

---

## What Is Context Engineering?

Context engineering is the practice of deliberately managing what information goes into an AI's context window — when, how much, and in what order — to maximize reasoning quality and minimize token waste.

The jarvOS context engineering integration is built on [Muratcan Koylan's Agent Skills for Context Engineering](https://github.com/muratcankoylan/Agent-Skills-for-Context-Engineering), adapted for OpenClaw workflows.

---

## When to Install This

Install this skill pack when you notice:

- **Repeated failures on the same task** — the agent forgets context across a long session
- **Spawning 2+ subagents regularly** — coordination overhead starts to compound
- **Context window warnings** — OpenClaw warns you about approaching limits
- **Lost-in-middle symptoms** — the agent references beginning/end of long docs but misses middle content
- **Token costs rising unexpectedly** — you're paying for context you don't need

---

## Installation

```bash
# Install via ClawHub
clawhub install agent-skills-context-engineering

# Verify installation
ls ~/.nvm/versions/node/*/lib/node_modules/openclaw/skills/agent-skills-context-engineering/
```

Or manually clone into your skills directory:

```bash
git clone https://github.com/muratcankoylan/Agent-Skills-for-Context-Engineering \
  "$(npm root -g)/openclaw/skills/agent-skills-context-engineering"
```

---

## Available Sub-Skills

The pack includes 13 sub-skills; common starters are listed below. You don't need all of them — start with the ones that match your actual pain points.

| Sub-Skill | When to Use |
|-----------|-------------|
| `context-optimization` | General context window efficiency |
| `context-compression` | Context approaching compaction (>70% used) |
| `context-degradation` | Repeated failures, lost-in-middle symptoms |
| `multi-agent-patterns` | Coordinating 2+ subagents |
| `memory-systems` | Setting up persistent memory architecture |
| `tool-design` | Building or refactoring agent tools/scripts |
| `filesystem-context` | Loading 5+ files as agent context |
| `evaluation-framework` | Testing and measuring agent performance |

---

## Auto-Trigger Setup

Add this section to your AGENTS.md (or TOOLS.md) to enable automatic sub-skill loading:

```markdown
## Context Engineering Auto-Triggers

| Trigger Condition | Sub-Skill | Action |
|---|---|---|
| Context approaching compaction | `context-compression` | Read before compaction fires |
| Spawning 2+ subagents in one session | `multi-agent-patterns` | Read before first spawn |
| Repeated task failure (3+ retries or loop) | `context-degradation` | Read before next retry |
| Building/refactoring agent tools | `tool-design` | Read when tool work begins |
| Setting up memory/persistence | `memory-systems` | Read when memory work begins |
| Loading 5+ files for context | `filesystem-context` | Read before loading files |
```

When you detect one of these conditions, read the sub-skill SKILL.md before proceeding. No user prompt needed — this is proactive quality improvement.

---

## Key Concepts from the Koylan Framework

**U-shaped attention curve:** Models recall beginning and end of context strongly; middle content gets lower attention weight. Critical rules should be front-loaded.

**Lost-in-middle:** Information in the middle of long contexts gets reduced attention. Files over 20K chars suffer this. Solution: progressive disclosure (load summaries first, full content only when needed).

**Context poisoning:** Low-quality or contradictory content in context degrades reasoning on unrelated content. Keep context clean.

**Attention budget:** Every token competes for limited attention. Add nothing that doesn't earn its place.

**Progressive disclosure (3-level loading):**
1. Routing file (always loaded) — lightweight, high-signal
2. Module (on-demand) — loaded when relevant
3. Data (as-needed) — specific files/records only when actively used

**Compaction trigger:** When context utilization >70%, summarize/compress before continuing.

---

## Example: Multi-Agent Pattern

When spawning multiple subagents for parallel work, the `multi-agent-patterns` sub-skill guides you to:

1. **Define clear boundaries** — each agent gets a slice with no ambiguous overlap
2. **Use explicit handoff docs** — agents write results to a shared file, not just back to chat
3. **Validate integration** — one agent verifies the combined output, not just the parts

```bash
# Load the sub-skill before spawning
# (The auto-trigger in AGENTS.md will handle this automatically)
cat "$(npm root -g)/openclaw/skills/agent-skills-context-engineering/skills/multi-agent-patterns/SKILL.md"
```

---

## Example: Context Compression

When a session is getting long, the `context-compression` sub-skill guides you to:

1. **Create a summary** of everything resolved so far
2. **Move resolved items out** of active context into a summary file
3. **Keep only active context** — current task + immediate blockers + key constraints
4. **Reference, don't repeat** — link to resolved items instead of including them inline

---

## Integration with JSONL Memory

Context engineering + JSONL memory work well together:

- Use `experiences.jsonl` to track what sub-skills were loaded and when → helps detect patterns
- Use `failures.jsonl` to log context-related failures → informs which sub-skills to auto-trigger
- Use `decisions.jsonl` to record architectural choices made while engineering context

See `docs/optional/jsonl-memory.md` for the memory schema.

---

## Resources

- **GitHub:** https://github.com/muratcankoylan/Agent-Skills-for-Context-Engineering
- **ClawHub:** `clawhub search context-engineering`
- **Local path (after install):** `~/.nvm/versions/node/*/lib/node_modules/openclaw/skills/agent-skills-context-engineering/`

---

*Start simple. Install this when you hit real pain, not in anticipation of it.*
