#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const {
  assertProjectionManifest,
  getManifest,
  getSkill,
  planSkillProjection,
  applySkillProjection,
  validateBundle,
} = require('../src');

const HARNESSES = ['claude-code', 'codex', 'openclaw', 'hermes'];
const SKILL = 'operator-communication';

test('operator-communication is registered with digest and four-harness projection', () => {
  const manifest = getManifest();
  const entry = manifest.skills.find((skill) => skill.name === SKILL);
  assert.ok(entry, 'skill must be in manifest');
  assert.equal(assertProjectionManifest(manifest), true);
  const validation = validateBundle();
  assert.equal(validation.ok, true, validation.errors.join('\n'));

  for (const harness of HARNESSES) {
    assert.ok(entry.supportedHarnesses.includes(harness), `missing harness ${harness}`);
    assert.ok(entry.projection.targets[harness], `missing target ${harness}`);
  }

  const skill = getSkill(SKILL);
  assert.ok(skill, 'getSkill returns skill');
  assert.match(skill.content, /name:\s*operator-communication/);
  assert.match(skill.content, /Four questions/);
  assert.match(skill.content, /What happened/);
  assert.match(skill.content, /Privacy boundary/);
  assert.match(skill.content, /Release-state wording/);
  assert.match(skill.content, /needs attention/i);
});

test('offline conformance fixtures cover the four-question checklist', () => {
  const skill = getSkill(SKILL);
  for (const needle of [
    'What happened',
    'What did jarvOS do',
    'Must the user act',
    'What happens next',
    'No action',
    'stack traces',
    'absolute paths',
    'currently published',
  ]) {
    assert.match(skill.content, new RegExp(needle, 'i'), `missing guidance: ${needle}`);
  }
});

test('managed projection discovers the skill for all four harnesses', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-operator-communication-'));
  try {
    for (const harness of HARNESSES) {
      const harnessRoot = path.join(root, harness);
      fs.mkdirSync(harnessRoot, { recursive: true });
      const plan = planSkillProjection({ harness, skillsRoot: harnessRoot, skills: [SKILL] });
      assert.equal(plan.entries.length, 1, harness);
      assert.notEqual(plan.entries[0].status, 'unsupported', `${harness} must support projection`);
      const applied = applySkillProjection(plan);
      assert.equal(applied.applied[0].applied, true, harness);
      const target = plan.entries[0].targetPath;
      assert.ok(fs.existsSync(target), `${harness} target missing`);
      const body = fs.readFileSync(target, 'utf8');
      assert.match(body, /operator-communication/);
      const clean = planSkillProjection({ harness, skillsRoot: harnessRoot, skills: [SKILL] });
      assert.equal(clean.entries[0].status, 'clean', harness);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('unsupported harness stays truthful instead of fake parity', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-operator-communication-unsup-'));
  try {
    const plan = planSkillProjection({ harness: 'not-a-harness', skillsRoot: root, skills: [SKILL] });
    assert.equal(plan.entries[0].status, 'unsupported');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
