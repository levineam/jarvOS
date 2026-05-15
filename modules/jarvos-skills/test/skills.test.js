#!/usr/bin/env node
'use strict';

const assert = require('assert');
const os = require('os');
const path = require('path');
const {
  getManifest,
  getSkill,
  listSkills,
  validateBundle,
  installSkills,
} = require('../src');

const manifest = getManifest();
assert.equal(manifest.bundle, 'operating-system-skills');
assert.deepEqual(manifest.defaultSkills, [
  'workflow-execution',
  'rule-creation',
  'context-management',
  'cron-hygiene',
]);
assert.equal(manifest.defaultSkills.includes('qmd'), false);

const validation = validateBundle();
assert.equal(validation.ok, true, validation.errors.join('\n'));
assert.equal(listSkills().length, 4);

for (const name of manifest.defaultSkills) {
  const skill = getSkill(name);
  assert.ok(skill, `expected skill: ${name}`);
  assert.ok(skill.content.includes(`name: ${name}`), `frontmatter missing for ${name}`);
}

const tempDir = path.join(os.tmpdir(), `jarvos-skills-test-${process.pid}`);
const installed = installSkills(tempDir, { skills: ['workflow-execution'], force: true });
assert.equal(installed.length, 1);
assert.ok(installed[0].path.endsWith(path.join('workflow-execution', 'SKILL.md')));

console.log('PASS @jarvos/skills bundle');
