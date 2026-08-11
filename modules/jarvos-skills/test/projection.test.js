#!/usr/bin/env node
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  applySkillProjection,
  assertProjectionManifest,
  getManifest,
  planSkillProjection,
} = require('../src');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-skills-projection-'));
const manifest = getManifest();
const digest = (value) => crypto.createHash('sha256').update(value).digest('hex');

try {
  assert.equal(assertProjectionManifest(manifest), true);
  assert.throws(
    () => assertProjectionManifest({ ...manifest, skills: [{ ...manifest.skills[0], source: { ...manifest.skills[0].source, digest: '' } }] }),
    /source missing digest/,
  );

  const first = planSkillProjection({ harness: 'hermes', skillsRoot: root, skills: ['workflow-execution'] });
  assert.equal(first.entries[0].status, 'missing');
  assert.equal(first.entries[0].action, 'create');
  assert.equal(planSkillProjection({ harness: 'codex', skillsRoot: root, skills: ['workflow-execution'] }).entries[0].status, 'unsupported');
  assert.equal(planSkillProjection({ harness: 'hermes', skillsRoot: root, skills: ['workflow-execution'], incompatibleSkills: ['workflow-execution'] }).entries[0].status, 'incompatible');
  const initial = applySkillProjection(first);
  assert.equal(initial.applied[0].applied, true);

  const clean = planSkillProjection({ harness: 'hermes', skillsRoot: root, skills: ['workflow-execution'] });
  assert.equal(clean.entries[0].status, 'clean');
  assert.equal(clean.entries[0].action, 'preserve');

  const target = clean.entries[0].targetPath;
  fs.writeFileSync(target, 'local edit\n');
  const local = planSkillProjection({ harness: 'hermes', skillsRoot: root, skills: ['workflow-execution'] });
  assert.equal(local.entries[0].status, 'local_modified');
  assert.equal(applySkillProjection(local).applied[0].applied, false);
  assert.equal(fs.readFileSync(target, 'utf8'), 'local edit\n');

  const unownedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-skills-projection-unowned-'));
  const unownedTarget = path.join(unownedRoot, 'workflow-execution', 'SKILL.md');
  fs.mkdirSync(path.dirname(unownedTarget), { recursive: true });
  fs.writeFileSync(unownedTarget, 'unowned skill\n');
  const unowned = planSkillProjection({ harness: 'hermes', skillsRoot: unownedRoot, skills: ['workflow-execution'] });
  assert.equal(unowned.entries[0].status, 'unknown');
  assert.equal(applySkillProjection(unowned).applied[0].applied, false);
  assert.equal(fs.readFileSync(unownedTarget, 'utf8'), 'unowned skill\n');
  fs.rmSync(unownedRoot, { recursive: true, force: true });

  const oldContent = 'previous reviewed skill\n';
  const oldDigest = digest(oldContent);
  fs.writeFileSync(target, oldContent);
  fs.writeFileSync(path.join(root, '.jarvos-projections', 'workflow-execution.json'), `${JSON.stringify({
    version: 1,
    harness: 'hermes',
    name: 'workflow-execution',
    sourceRevision: 'old',
    sourceDigest: oldDigest,
    targetDigest: oldDigest,
    renderer: 'raw-skill-md',
  })}\n`);
  const outdated = planSkillProjection({ harness: 'hermes', skillsRoot: root, skills: ['workflow-execution'] });
  assert.equal(outdated.entries[0].status, 'outdated');
  applySkillProjection(outdated);
  assert.equal(planSkillProjection({ harness: 'hermes', skillsRoot: root, skills: ['workflow-execution'] }).entries[0].status, 'clean');

  fs.writeFileSync(target, oldContent);
  fs.writeFileSync(path.join(root, '.jarvos-projections', 'workflow-execution.json'), `${JSON.stringify({
    version: 1,
    harness: 'hermes',
    name: 'workflow-execution',
    sourceRevision: 'old',
    sourceDigest: oldDigest,
    targetDigest: oldDigest,
    renderer: 'raw-skill-md',
  })}\n`);
  const generation = planSkillProjection({ harness: 'hermes', skillsRoot: root, skills: ['workflow-execution'] });
  assert.equal(generation.entries[0].status, 'outdated');
  fs.writeFileSync(target, 'changed after planning\n');
  assert.throws(() => applySkillProjection(generation), /Projection changed since planning/);

  const unsafeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-skills-projection-link-'));
  fs.mkdirSync(path.join(unsafeRoot, 'workflow-execution'));
  fs.symlinkSync(os.tmpdir(), path.join(unsafeRoot, 'workflow-execution', 'SKILL.md'));
  assert.throws(
    () => planSkillProjection({ harness: 'hermes', skillsRoot: unsafeRoot, skills: ['workflow-execution'] }),
    /unsafe symbolic link/,
  );
  fs.rmSync(unsafeRoot, { recursive: true, force: true });
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log('PASS @jarvos/skills projection');
