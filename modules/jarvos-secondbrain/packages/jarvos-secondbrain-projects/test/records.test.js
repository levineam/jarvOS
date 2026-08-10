'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  ProjectRegistry,
  REGISTRY_CONTRACT,
  STATUS_BY_KIND,
  validateRecord,
} = require('../src/registry');

function tempState() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-project-registry-'));
}

function makeRegistry() {
  return new ProjectRegistry({ stateDir: tempState(), now: () => '2026-08-09T00:00:00.000Z' });
}

test('canonical records expose a versioned project/outcome contract', () => {
  assert.equal(REGISTRY_CONTRACT, 'jarvos.projects-registry/v1');
  assert.deepEqual(STATUS_BY_KIND.project, ['active', 'paused', 'archived']);
  assert.deepEqual(STATUS_BY_KIND.outcome, ['planned', 'active', 'complete', 'archived']);

  const result = validateRecord({
    id: 'prj_000001',
    kind: 'project',
    title: 'jarvOS',
    aliases: ['jarvos'],
    parentId: null,
    lifecycle: 'active',
    declaredPriority: 'unset',
    revision: 1,
    createdAt: '2026-08-09T00:00:00.000Z',
    updatedAt: '2026-08-09T00:00:00.000Z',
  });

  assert.equal(result.ok, true);
  assert.equal(result.record.kind, 'project');
});

test('registry creates a project and an outcome with stable breadcrumb identity', () => {
  const registry = makeRegistry();
  const project = registry.create({ title: 'jarvOS', declaredPriority: 'high' });
  const outcome = registry.create({
    kind: 'outcome',
    title: 'v1.0.0 release',
    parentId: project.record.id,
  }, { expectedGeneration: project.generation });

  assert.match(project.record.id, /^prj_/);
  assert.match(outcome.record.id, /^out_/);
  assert.equal(registry.breadcrumb(outcome.record.id), 'jarvOS › v1.0.0 release');
  assert.equal(registry.get(outcome.record.id).parentId, project.record.id);
});

test('outcomes are leaves and lifecycle/status combinations are closed', () => {
  const registry = makeRegistry();
  const project = registry.create({ title: 'jarvOS' });

  assert.throws(() => registry.create({
    kind: 'outcome', title: 'orphan', lifecycle: 'planned',
  }, { expectedGeneration: project.generation }), /outcome requires a project parent/);

  const outcome = registry.create({
    kind: 'outcome', title: 'release', parentId: project.record.id,
  }, { expectedGeneration: project.generation });

  assert.throws(() => registry.create({
    kind: 'project', title: 'nested', parentId: outcome.record.id,
  }, { expectedGeneration: outcome.generation }), /parent must be a project/);

  assert.throws(() => registry.update(outcome.record.id, {
    lifecycle: 'paused',
  }, { expectedGeneration: outcome.generation, expectedRevision: outcome.record.revision }), /invalid lifecycle/);

  assert.throws(() => registry.update(project.record.id, {
    parentId: project.record.id,
  }, { expectedGeneration: outcome.generation, expectedRevision: project.record.revision }), /hierarchy contains a cycle/);
});

test('priority inheritance reports declared, effective, and source values', () => {
  const registry = makeRegistry();
  const project = registry.create({ title: 'jarvOS', declaredPriority: 'high' });
  const inherited = registry.create({
    kind: 'outcome', title: 'release', parentId: project.record.id,
  }, { expectedGeneration: project.generation });

  assert.deepEqual(registry.priority(inherited.record.id), {
    declared: 'unset',
    effective: 'high',
    source: 'inherited',
    sourceRecordId: project.record.id,
    sourceKind: 'project',
  });

  const overridden = registry.update(inherited.record.id, {
    declaredPriority: 'low',
  }, { expectedGeneration: inherited.generation, expectedRevision: inherited.record.revision });
  assert.deepEqual(registry.priority(overridden.record.id), {
    declared: 'low',
    effective: 'low',
    source: 'explicit',
    sourceRecordId: overridden.record.id,
    sourceKind: 'outcome',
  });
});

test('duplicate aliases resolve ambiguously instead of guessing', () => {
  const registry = makeRegistry();
  const first = registry.create({ title: 'jarvOS', aliases: ['the system'] });
  const second = registry.create({ title: 'Other project', aliases: ['the system'] }, {
    expectedGeneration: first.generation,
  });

  assert.deepEqual(registry.resolve('the system'), {
    status: 'ambiguous',
    candidates: [first.record.id, second.record.id],
  });
  assert.deepEqual(registry.resolve('missing'), { status: 'not-found' });
});

test('stale graph generations cannot overwrite newer mutations', () => {
  const stateDir = tempState();
  const first = new ProjectRegistry({ stateDir });
  const second = new ProjectRegistry({ stateDir });
  const created = first.create({ title: 'jarvOS' });

  second.reload();
  const firstUpdate = first.update(created.record.id, { title: 'jarvOS core' }, {
    expectedGeneration: created.generation,
    expectedRevision: created.record.revision,
  });

  assert.throws(() => second.update(created.record.id, { title: 'wrong writer' }, {
    expectedGeneration: created.generation,
    expectedRevision: created.record.revision,
  }), /stale registry generation/);
  assert.equal(firstUpdate.record.title, 'jarvOS core');
  assert.equal(new ProjectRegistry({ stateDir }).get(created.record.id).title, 'jarvOS core');
});

test('incomplete generation files are ignored while the committed generation remains readable', () => {
  const stateDir = tempState();
  const registry = new ProjectRegistry({ stateDir });
  const created = registry.create({ title: 'jarvOS' });
  fs.writeFileSync(path.join(stateDir, 'generation-9999999999.json.tmp-crash'), '{"broken":true}', 'utf8');

  const recovered = new ProjectRegistry({ stateDir });
  assert.equal(recovered.get(created.record.id).title, 'jarvOS');
  assert.equal(recovered.integrity().ok, true);
});
