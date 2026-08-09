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
  stageProjectionPackage,
  validateProjectionAdapter,
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

  const escapedRootLink = `${root}-escaped-link`;
  fs.symlinkSync(root, escapedRootLink);
  assert.throws(() => planSkillProjection({ harness: 'hermes', skillsRoot: escapedRootLink, skills: ['workflow-execution'] }), /real directory/);
  fs.unlinkSync(escapedRootLink);
  const writableRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-skills-projection-writable-'));
  fs.chmodSync(writableRoot, 0o777);
  assert.throws(() => planSkillProjection({ harness: 'hermes', skillsRoot: writableRoot, skills: ['workflow-execution'] }), /must not be group- or world-writable/);
  fs.chmodSync(writableRoot, 0o700);
  fs.rmSync(writableRoot, { recursive: true, force: true });

  const adapter = {
    id: 'test-harness-agent-skills',
    version: '1.2.3',
    harness: 'test-harness',
    supportedVersions: '>=2.0.0 <3.0.0',
    rootDetection: { kind: 'configured-path' },
    discovery: { command: ['test-harness', 'skills', 'list'], fixture: 'explore-unknowns' },
  };
  assert.equal(validateProjectionAdapter(adapter, '2.4.0').status, 'compatible');
  assert.equal(validateProjectionAdapter(adapter, '3.0.0').status, 'unsupported');
  assert.equal(validateProjectionAdapter(adapter, 'not-a-version').status, 'unsupported');
  assert.throws(() => validateProjectionAdapter({ ...adapter, discovery: {} }, '2.4.0'), /discovery command/);

  const transformedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-skills-transformed-'));
  const transform = (content) => Buffer.concat([content, Buffer.from('\n<!-- adapted -->\n')]);
  const transformed = planSkillProjection({
    harness: 'hermes',
    skillsRoot: transformedRoot,
    skills: ['workflow-execution'],
    adapter: { ...adapter, harness: 'hermes' },
    harnessVersion: '2.4.0',
    transform,
  });
  assert.notEqual(transformed.entries[0].outputDigest, transformed.entries[0].sourceDigest);
  assert.deepEqual(transformed.entries[0].adapter, { id: adapter.id, version: adapter.version, harness: 'hermes' });
  applySkillProjection(transformed, { adapter: { ...adapter, harness: 'hermes' }, harnessVersion: '2.4.0', transform });
  const transformedReceipt = JSON.parse(fs.readFileSync(path.join(transformedRoot, '.jarvos-projections', 'workflow-execution.json'), 'utf8'));
  assert.equal(transformedReceipt.sourceDigest, transformed.entries[0].sourceDigest);
  assert.equal(transformedReceipt.targetDigest, transformed.entries[0].outputDigest);
  assert.deepEqual(transformedReceipt.adapter, transformed.entries[0].adapter);
  assert.throws(
    () => applySkillProjection(transformed, { adapter: { ...adapter, harness: 'hermes' }, harnessVersion: '2.4.0', transform: (content) => content }),
    /Projection changed since planning/,
  );
  fs.rmSync(transformedRoot, { recursive: true, force: true });

  const packageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-skills-package-'));
  const stagingRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-skills-staging-'));
  fs.mkdirSync(path.join(packageRoot, 'skill'));
  fs.writeFileSync(path.join(packageRoot, 'skill', 'SKILL.md'), 'staged skill\n');
  const staged = stageProjectionPackage({
    packageRoot,
    stagingRoot,
    entries: [{ path: 'skill/SKILL.md', digest: digest('staged skill\n') }],
  });
  assert.equal(fs.readFileSync(path.join(staged.path, 'skill', 'SKILL.md'), 'utf8'), 'staged skill\n');
  assert.equal((fs.statSync(staged.path).mode & 0o077), 0);
  assert.throws(() => stageProjectionPackage({ packageRoot, stagingRoot, entries: [{ path: '/tmp/escape', digest: digest('x') }] }), /relative/);
  assert.throws(() => stageProjectionPackage({ packageRoot, stagingRoot, entries: [{ path: '../escape', digest: digest('x') }] }), /traversal/);
  assert.throws(() => stageProjectionPackage({ packageRoot, stagingRoot, entries: [
    { path: 'skill/SKILL.md', digest: digest('staged skill\n') },
    { path: 'skill/./SKILL.md', digest: digest('staged skill\n') },
  ] }), /duplicate/);
  fs.symlinkSync(path.join(packageRoot, 'skill', 'SKILL.md'), path.join(packageRoot, 'link.md'));
  assert.throws(() => stageProjectionPackage({ packageRoot, stagingRoot, entries: [{ path: 'link.md', digest: digest('staged skill\n') }] }), /symbolic link/);
  fs.mkdirSync(path.join(packageRoot, 'directory-entry'));
  assert.throws(() => stageProjectionPackage({ packageRoot, stagingRoot, entries: [{ path: 'directory-entry', digest: digest('') }] }), /regular file/);
  fs.rmSync(packageRoot, { recursive: true, force: true });
  fs.rmSync(stagingRoot, { recursive: true, force: true });
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log('PASS @jarvos/skills projection');
