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
- `idea-parking` remains available for explicit caller-owned review queues, but
  medium-confidence candidates are ignored by the default journal flow.

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

## GBrain Skillpack Boundary

GBrain 0.42.52.0+ gives jarvOS three useful skill surfaces:

- **Scaffolded skills:** generated starting points that become jarvOS-owned files
  after review.
- **Reference skills:** upstream GBrain skill content that jarvOS can diff against
  without copying automatically.
- **Brain-resident skills:** skills discovered from a connected GBrain brain at
  runtime.

This bridge reports those surfaces as provider evidence. It does not silently
install, overwrite, or delete `SKILL.md` files. Any change to a jarvOS-owned skill
still needs a tracked execution issue, local review, and the same capture
contract checks as a manually-authored change.

GBrain can help an agent find brain-native context before capture. Intentional
note or journal capture still routes through `jarvos-secondbrain` unless the
GBrain path supplies the same provenance, backlink, privacy, and QMD pending
guarantees.
