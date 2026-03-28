# Memory Promotion Rules

Memory is for **durable agent state**, not for every interesting thing Andrew wrote or every
step an agent took.

## Routing model

| Surface | What belongs there | What does not |
| --- | --- | --- |
| Journal / daily logs | chronology, raw capture, uncertain notes, what happened today | long-lived retained memory |
| Notes / secondbrain | long-form research, architecture, source docs, rich context | compact agent recall |
| Memory | compact retained state with provenance | long narratives, task mirrors, transient churn |
| Ontology | structured beliefs, goals, projects, relationships | every fact or preference verbatim |
| Paperclip | live issue state, ownership, execution evidence | durable memory summaries |

## Promotion test

Promote something into Memory only when losing it would make a future session worse and the
best recovery path is compact recall rather than reopening a long document.

A candidate should be:
- durable across more than one day
- specific enough to verify or source
- compact enough to scan quickly
- helpful to an agent making later decisions

## Default class routing

- **Fact** -> `MEMORY.md`
- **Preference** -> `MEMORY.md`
- **Decision** -> `memory/decisions/YYYY-MM-DD-slug.md`
- **Lesson** -> `memory/lessons/YYYY-MM-DD-slug.md`
- **Project State** -> `memory/projects/`

## Promotion sources

### Journal -> Memory
Use Journal as source material when a daily event hardens into something durable:
- repeated preference
- stable fact
- meaningful project-state change
- durable decision or lesson

Do not promote routine chronology just because it happened.

### Notes / secondbrain -> Memory
Use Notes as source material when long-form content yields a compact retained insight:
- architecture decision worth preserving
- stable operating rule
- persistent project context that should survive outside the note

Do not mirror full notes into Memory.

### Paperclip -> Memory
Paperclip may produce a Memory artifact when a completed issue leaves behind:
- a durable decision
- a reusable lesson
- a project-state update worth preserving

Paperclip still owns the live task state.

## Update and supersession rules

When a memory changes:
- prefer updating or superseding the old durable memory
- keep one current version when possible
- preserve provenance to the prior state when relevant
- do not silently overwrite history if the change matters

## Integration with ontology

Promoted Memory can inform ontology when it reveals:
- a stable belief
- a real project change
- a recurring preference with strategic impact
- a decision that changes goals or constraints

Memory is the compact recall layer.
Ontology is the structured worldview layer.
