'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Ajv = require('ajv');

const {
  skillContractSchema,
  contracts,
  getSkillContract,
  listSkillContracts,
} = require('../bridge/skills');

function makeValidator() {
  return new Ajv({
    allErrors: true,
    strict: false,
  });
}

test('skill contract schema validates and all capture contracts conform', () => {
  const ajv = makeValidator();
  assert.equal(ajv.validateSchema(skillContractSchema), true, ajv.errorsText(ajv.errors));

  const validate = ajv.compile(skillContractSchema);
  for (const contract of contracts) {
    assert.equal(validate(contract), true, `${contract.name}: ${ajv.errorsText(validate.errors)}`);
  }
});

test('contract input and output schemas compile as JSON Schema', () => {
  const ajv = makeValidator();

  for (const contract of contracts) {
    assert.doesNotThrow(() => ajv.compile(contract.input), `${contract.name} input schema must compile`);
    assert.doesNotThrow(() => ajv.compile(contract.output), `${contract.name} output schema must compile`);
  }
});

test('idea-parking requires an explicit review queue', () => {
  const ajv = makeValidator();
  const validate = ajv.compile(getSkillContract('idea-parking').input);

  assert.equal(validate({
    text: 'I like using TypeScript for new projects.',
    confidence: 0.7,
    salienceClass: 'preference',
  }), false);

  assert.equal(validate({
    text: 'I like using TypeScript for new projects.',
    confidence: 0.7,
    salienceClass: 'preference',
    reviewQueue: 'capture-review',
  }), true, ajv.errorsText(validate.errors));
});

test('capture and routing contracts are importable by stable name', () => {
  assert.deepEqual(
    listSkillContracts().map((contract) => contract.name).sort(),
    ['idea-parking', 'journal-entry', 'memory-promotion', 'note-creation', 'work-intake'],
  );

  assert.equal(getSkillContract('journal-entry').name, 'journal-entry');
  assert.equal(getSkillContract('note-creation').name, 'note-creation');
  assert.equal(getSkillContract('idea-parking').name, 'idea-parking');
  assert.equal(getSkillContract('memory-promotion').name, 'memory-promotion');
  assert.equal(getSkillContract('work-intake').name, 'work-intake');
  assert.equal(getSkillContract('missing-contract'), null);
});

test('contracts declare classifier-compatible trigger conditions', () => {
  const classifierFields = new Set([
    'captured',
    'trigger',
    'salienceClass',
    'confidence',
    'path',
    'destinations',
  ]);

  for (const contract of contracts) {
    for (const trigger of contract.triggers) {
      const fields = Object.keys(trigger.when);
      assert.ok(fields.length > 0, `${contract.name} trigger must declare conditions`);
      for (const field of fields) {
        assert.ok(classifierFields.has(field), `${contract.name} uses unsupported trigger field ${field}`);
      }
    }
  }
});

test('contracts declare adapter-backed writes', () => {
  for (const contract of contracts) {
    assert.ok(contract.adapters.length > 0, `${contract.name} must declare adapter dependencies`);
    assert.ok(
      contract.capabilities.some((capability) => capability.writes.length > 0),
      `${contract.name} must declare at least one adapter-backed write`,
    );
  }

  const noteCreation = getSkillContract('note-creation');
  assert.ok(
    noteCreation.adapters.some((adapter) => adapter.name === 'notes' && adapter.required),
    'note-creation must declare the notes writer dependency',
  );
});
