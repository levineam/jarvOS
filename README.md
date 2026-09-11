# jarvOS

jarvOS — your own personal superintelligence, accessible to all.

jarvOS builds on Markdown files you own to create a cross-AI digital twin: a shared second brain that OpenClaw, Codex, Claude Code, Hermes, and future agents can all use.

The goal is simple:

**One mind, many harnesses.**

Different AI tools should not have separate memories, workflows, and understandings of you. They should connect to the same personal superintelligence through whichever harness you choose. A harness is the environment an AI works in, such as Codex, Claude Code, or Hermes.

## What Is It?

jarvOS is a modular, local-first secondbrain system for AI agents.

It starts with Markdown as the human-readable foundation. Your notes, journals, ideas, decisions, source material, and written project context live in files you own.

Then jarvOS adds modules that let AI agents capture, retrieve, organize, and act on that context consistently across tools.

## The Core Stack

### Markdown, with Obsidian as an optional interface

Markdown is the durable foundation of the second brain. You should be able to read and edit your notes without depending on a particular app.

We currently use Obsidian because it is free to use, works with local Markdown files, and makes connected notes easy to explore. It provides a useful interface for reading, linking, and organizing your knowledge while keeping the underlying files yours.

Obsidian is optional in jarvOS's portable architecture. Integrations that use the running Obsidian app depend on it; the Markdown foundation does not.

### qmd

qmd provides fast local search over Markdown.

jarvOS uses qmd so agents can retrieve context from notes, journals, generated wiki pages, and other Markdown collections without depending on a hosted memory database.

### LLM Wiki

jarvOS uses the LLM-wiki pattern to generate AI-readable wiki pages from source notes, journals, and captured session material.

The generated wiki is not the source of truth. It is a rebuildable retrieval layer that helps agents find concepts, decisions, source pages, summaries, and links.

### lossless-claw

lossless-claw helps long OpenClaw sessions preserve continuity across context limits.

It is not the secondbrain itself. It helps agents keep the thread while jarvOS keeps durable knowledge grounded in Markdown.

## jarvOS Modules

### `@jarvos/secondbrain`

The secondbrain module owns the Markdown knowledge layer.

It handles intentional capture, note creation, journal routing, source provenance, generated wiki inputs, qmd freshness state, and secondbrain status checks.

When an agent captures a note, idea, decision, quote, preference, fact, or lesson, this module makes sure it lands in the right place with the right metadata and a link back to the daily journal.

### `@jarvos/memory`

The memory module owns compact durable recall.

Not everything belongs in long-term memory. jarvOS keeps source notes and journals as the authority, then promotes only useful, source-backed knowledge into memory.

This prevents raw transcripts and noisy captures from polluting the user’s durable context.

### `@jarvos/gbrain`

The GBrain module adds structured recall.

Where qmd helps agents search Markdown, GBrain helps organize and retrieve higher-level relationships: projects, goals, concepts, decisions, and other structured knowledge.

It helps the secondbrain become more than a pile of files.

### `@jarvos/agent-context`

The agent-context module gives AI tools a shared way to orient.

It exposes current work, note capture, recall, and session continuity tools so different agents can enter the same jarvOS context instead of starting cold.

This is one of the key pieces behind seamless transitions between AIs.

### `@jarvos/coding`

The coding module makes repo-aware agents work from the same execution model.

It supports coding workflows across tools like Codex and Claude Code while preserving issue context, branch state, review expectations, and continuity.

If its coding workflow provider is unavailable, jarvOS falls back to its native workflow in the same run and worktree.

The goal is that implementation work feels consistent no matter which coding agent is doing it.

### `@jarvos/skills`

The skills module packages reusable agent behavior.

It includes operating patterns for workflow execution, context management, rule creation, cron hygiene, Obsidian workflows, and local runtime profiles.

Skills are how jarvOS teaches different agents to behave like parts of the same system.

### `@jarvos/runtime-kit`

The runtime kit helps new agent runtimes plug into jarvOS.

It provides adapter manifests, scaffolding, and checks so future AI tools can connect to the shared secondbrain without hardcoding one runtime as the center of the product.

## How It Works Together

The modules form one pipeline:

1. Markdown files store the human-readable secondbrain, with Obsidian as an optional interface.
2. `@jarvos/secondbrain` captures notes, ideas, decisions, and source-backed knowledge.
3. LLM Wiki generates AI-readable retrieval pages from the source material.
4. qmd indexes the Markdown so agents can search it locally.
5. `@jarvos/memory` promotes only the durable, source-backed pieces worth remembering.
6. `@jarvos/gbrain` adds structured recall over relationships and higher-level context.
7. `@jarvos/agent-context` exposes that shared context to different AI agents.
8. `@jarvos/coding` lets coding agents act on work with consistent continuity.
9. `@jarvos/skills` and `@jarvos/runtime-kit` make the whole system portable across tools.

That is the cross-AI digital twin: a shared second brain that many AI agents can use across different harnesses.

## Supported AI Agents

jarvOS currently targets:

- **OpenClaw**
- **Codex**
- **Claude Code**
- **Hermes**
- **future agents through adapter contracts**

The important point is not any single agent.

The important point is that each agent can enter the same secondbrain, follow the same capture rules, retrieve the same context, and preserve knowledge in the same durable place.

## Core Principles

### Markdown First

The user should be able to open, read, edit, and move their notes without depending on a particular app.

### Markdown Is The Source Of Truth

Generated wiki pages, sidecars, queues, indexes, and memory records support the system. They do not replace the source notes.

### Cross-AI By Design

OpenClaw, Codex, Claude Code, Hermes, and future agents should share one secondbrain instead of creating fragmented memories.

### Capture Must Be Source-Backed

Captured knowledge should carry provenance, evidence, privacy state, and a clear reason to exist.

### Best OSS, Wired Together

jarvOS should use strong existing software wherever possible, then build the missing integration layer: modules, contracts, adapters, workflows, evals, safety gates, and defaults.

## The Destination

jarvOS is your own personal superintelligence, accessible to all.

It is a cross-AI digital twin built on a real second brain: Markdown at the foundation, useful tools connected around it, and jarvOS modules making the whole thing work as one mind across many harnesses.
