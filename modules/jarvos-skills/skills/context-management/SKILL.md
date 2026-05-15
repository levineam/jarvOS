---
name: context-management
description: Maintain the live agent context surface: bootstrap hygiene, memory routing, conversation continuity, and context-health monitoring.
triggers:
  - context drift
  - context budget
  - where should this live
  - bootstrap hygiene
  - memory routing
  - context-management
metadata:
  jarvos:
    bundle: operating-system-skills
    portability: generic
---

# Context Management

Use this skill when editing always-loaded files, deciding where durable knowledge
belongs, diagnosing context bloat, or preserving continuity across compaction.

## Contract

The workflow is complete only when:

- the request is classified into one context lane
- only the relevant files are loaded
- durable knowledge is routed to the right store
- always-loaded files stay compact and role-pure
- touched files are re-read or linted after edits

## Context lanes

| Lane | Use when | Output |
|---|---|---|
| Bootstrap hygiene | Root instruction files are too large, stale, or mixed-purpose | Smaller root files with pointers to deeper docs/skills |
| Memory routing | A fact, preference, lesson, decision, or project state needs a home | Correct durable memory/document location |
| Conversation continuity | Compaction, transcript recovery, or session handoff is the problem | Recovery summary and source-of-truth refresh |
| Monitoring/maintenance | Watchdogs, context budgets, or trend reports show drift | Diagnosis, targeted cleanup, and verification |

## Routing rules

- Facts and preferences go to the durable memory surface.
- Decisions with tradeoffs go to decision records.
- Lessons from mistakes go to lessons.
- Project state goes to project state or the tracker.
- Operational procedures become skills or docs, with a short pointer from the
  always-loaded file.
- Brain-native objects such as people, companies, concepts, beliefs, and goals
  belong in the workspace's chosen structured knowledge layer.

## Always-loaded file hygiene

Keep root instructions short. They should contain durable rules, routing
pointers, and triggers. Move long procedures to skills, references, or docs.

Before deleting content, diagnose why it is no longer needed. Watchdog output is
evidence, not an automatic pruning command.

## Verification

After editing:

1. Re-read the touched file or run the relevant lint/check.
2. Confirm the file still has one clear job.
3. Confirm any moved content has a pointer from the original surface if users or
   agents need to find it.
