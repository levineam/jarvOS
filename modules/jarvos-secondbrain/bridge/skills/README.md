# bridge/skills

Skill contracts define the public capture behavior above `bridge/routing`.
Routing code may evolve, but each skill contract keeps the same portable shape:

```js
{
  name,
  version,
  description,
  triggers: [],
  input: schema,
  output: schema,
  capabilities: [],
  adapters: []
}
```

`triggers[].when` intentionally mirrors classifier and capture-router output:
`trigger`, `salienceClass`, `confidence`, `path`, `captured`, and
`destinations`. That lets any AI assistant, CLI, or adapter choose a skill from
the same small contract without depending on local implementation details.

## Contracts

- `journal-entry` captures `idea` and high-confidence thought intents into the
  daily journal.
- `note-creation` captures note intents into an Obsidian markdown note and adds
  a `[[wikilink]]` under the journal Notes section.
- `idea-parking` parks medium-confidence candidates in `## 📌 Flagged` for
  review instead of promoting them as canonical notes.

## Import

```js
const {
  skillContractSchema,
  contracts,
  getSkillContract,
} = require('./bridge/skills');
```

Validate `contracts` against `skillContractSchema` with any draft-07 JSON Schema
validator before loading them into a runtime.
