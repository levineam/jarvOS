#!/usr/bin/env node
'use strict';

const assert = require('assert');
const os = require('os');
const path = require('path');
const {
  buildInstallPlan,
  getManifest,
  getSkill,
  listPacks,
  listSkills,
  loadPack,
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

const fs = require('fs');

const tempDir = path.join(os.tmpdir(), `jarvos-skills-test-${process.pid}`);
const installed = installSkills(tempDir, { skills: ['workflow-execution'], force: true });
assert.equal(installed.length, 1);
assert.ok(installed[0].path.endsWith(path.join('workflow-execution', 'SKILL.md')));

// Preflight overwrite check: if any selected target already exists and force is false,
// no skill should be copied — destination must remain unchanged.
const preflightDir = path.join(os.tmpdir(), `jarvos-skills-preflight-${process.pid}`);
fs.rmSync(preflightDir, { recursive: true, force: true });
// Pre-create only the second target so the first install would mutate state before throwing
// under the old non-preflight behavior.
const existingTarget = path.join(preflightDir, 'rule-creation', 'SKILL.md');
fs.mkdirSync(path.dirname(existingTarget), { recursive: true });
fs.writeFileSync(existingTarget, 'preexisting content');
const firstTarget = path.join(preflightDir, 'workflow-execution', 'SKILL.md');
assert.equal(fs.existsSync(firstTarget), false, 'workflow-execution should not exist before install');
assert.throws(
  () => installSkills(preflightDir, { skills: ['workflow-execution', 'rule-creation'] }),
  /Refusing to overwrite existing skill without force/,
);
assert.equal(fs.existsSync(firstTarget), false, 'workflow-execution must not be copied when a later target already exists');
assert.equal(fs.readFileSync(existingTarget, 'utf8'), 'preexisting content', 'preexisting skill content must be untouched');

const obsidianPack = loadPack('obsidian-default');
assert.equal(obsidianPack.name, 'obsidian-default');
assert.equal(obsidianPack.source.repo, 'https://github.com/kepano/obsidian-skills');
assert.equal(obsidianPack.source.commit, '553ef99');
assert.equal(obsidianPack.boundary.foundationRequired, false);
assert.equal(obsidianPack.boundary.contentContractOwner, '@jarvos/secondbrain');
assert.equal(obsidianPack.release.targetVersion, 'v0.3.0');
assert.equal(obsidianPack.release.releaseParentIssue, 'SUP-1957');
assert.deepEqual(obsidianPack.skills.map((skill) => skill.name).sort(), [
  'defuddle',
  'json-canvas',
  'obsidian-bases',
  'obsidian-cli',
  'obsidian-markdown',
]);
assert.ok(listPacks().includes('obsidian-default'), 'obsidian-default pack should be discoverable');

const guardedText = obsidianPack.skills
  .filter((skill) => skill.name === 'obsidian-bases' || skill.name === 'json-canvas')
  .flatMap((skill) => skill.guardrails)
  .join(' ');
assert.match(guardedText, /not a project-management replacement|not the live system of record/i);
assert.match(guardedText, /Paperclip issue status|tasks or blockers/i);

const missingToolsPlan = buildInstallPlan({
  pack: obsidianPack,
  commandsPresent: {
    obsidian: false,
    defuddle: false,
  },
});
assert.equal(missingToolsPlan.status, 'needs-optional-tools');
assert.deepEqual(missingToolsPlan.missingCommands, ['defuddle', 'obsidian']);
assert.equal(missingToolsPlan.skills.find((skill) => skill.name === 'obsidian-markdown').ready, true);
assert.equal(missingToolsPlan.skills.find((skill) => skill.name === 'obsidian-cli').ready, false);
assert.match(missingToolsPlan.setup.join(' '), /JARVOS_NOTES_DIR/);
assert.match(missingToolsPlan.setup.join(' '), /Paperclip as the live task authority/);

const readyPlan = buildInstallPlan({
  pack: obsidianPack,
  commandsPresent: {
    obsidian: true,
    defuddle: true,
  },
});
assert.equal(readyPlan.status, 'ready');
assert.deepEqual(readyPlan.missingCommands, []);
assert.equal(readyPlan.skills.every((skill) => skill.ready), true);

console.log('PASS @jarvos/skills bundle');
