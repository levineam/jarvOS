---
name: rule-creation
description: Wire new rules, policies, and behavioral constraints into the correct governance file with an explicit enforcement assessment.
triggers:
  - make a rule
  - add this rule
  - from now on
  - formalize that
  - new policy
  - rule-creation
metadata:
  jarvos:
    bundle: operating-system-skills
    portability: generic
---

# Rule Creation

Use this skill when a user declares, proposes, or asks to formalize a behavioral
rule. Do not leave the rule as a chat promise. Wire it into the system of record,
then report what changed.

## Contract

The workflow is complete only when:

- the rule has a name, type, and target governance file
- enforcement need has been assessed
- high-stakes or multi-step rules get an enforcement mechanism when the runtime
  supports one
- the rule is written before the response claims it will be followed
- the final response names the file and enforcement status

## Rule shape

```md
## Rule Name (HARD|soft)

Plain-language requirement.

**Enforced by:** `path/to/workflow-or-script` (when applicable)
```

## Routing

| Rule type | Typical destination |
|---|---|
| Always-loaded behavior | `AGENTS.md` or equivalent root instructions |
| Tool/CLI policy | `TOOLS.md` or equivalent tooling guide |
| Non-negotiable safety | `CRITICAL-RULES.md` or root instructions |
| Persona/voice | `SOUL.md`, `IDENTITY.md`, or persona docs |
| Project-only rule | Project issue, project brief, or project docs |

## Enforcement assessment

Create enforcement when any condition is true:

- the rule affects external messages, publishing, money, secrets, production, or
  destructive actions
- a similar rule has been violated before
- the rule requires a multi-step ordered gate
- a script/workflow/tool restriction can make violation materially harder

Choose the lightest effective mechanism:

- workflow gate for multi-step approval or sequencing
- lint script for one validation check
- tool restriction when an action should never be called directly
- doc-only when judgment is enough and risk is low

## Final report

```md
Rule wired: <name>
Location: <file>
Type: HARD|soft
Enforcement: <workflow/script/tool restriction/doc-only/unavailable>
```
