'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { ProjectRegistry } = require('../src/registry');
const migration = require('../src/migrate');

const SOURCE_PATH = '/vault/Projects/jarvOS v1.0.0 release.md';
const SOURCE = [
  '---',
  'type: project',
  'title: jarvOS v1.0.0 release',
  'status: active',
  'created: 2026-08-01',
  '---',
  '',
  '# jarvOS v1.0.0 release',
  '',
  '## Goal',
  'Publish the current jarvOS release.',
  '',
  '## High-level plan',
  'Repair, verify, approve, publish.',
  '',
  '## Definition of Done',
  'The release is publicly verified.',
  '',
].join('\n');

function mapping({ sourceDigest, approved = true } = {}) {
  return {
    version: 'jarvOS-project-mapping-1',
    entries: [{
      sourcePath: SOURCE_PATH,
      sourceDigest,
      approved,
      project: { title: 'jarvOS', aliases: ['jarvOS v1.0.0 release'], declaredPriority: 'high' },
      outcome: { title: 'v1.0.0 release' },
      fieldDispositions: {
        title: 'discard',
        goal: 'project.goal',
        plan: 'project.goal',
        definitionOfDone: 'outcome.definitionOfDone',
        status: 'project.lifecycle',
        createdAt: 'project.createdAt',
        updatedAt: 'project.updatedAt',
        sourceTitle: 'project.aliases',
      },
    }],
  };
}

function makeRegistry() {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-migration-registry-'));
  return new ProjectRegistry({ stateDir, now: () => '2026-08-08T12:00:00.000Z' });
}

test('dry-run requires explicit mapping and never mutates the registry', () => {
  const registry = makeRegistry();
  const plan = migration.buildMigrationPlan({ sources: [{ path: SOURCE_PATH, content: SOURCE }], mapping: { version: '1', entries: [] } });
  assert.equal(plan.status, 'proposed');
  assert.equal(plan.targets.length, 0);
  assert.equal(plan.proposals[0].reason, 'explicit-mapping-required');
  assert.equal(registry.list().length, 0);
});
test('approved mapping creates jarvOS and its release Outcome, then reruns idempotently', () => {
  const registry = makeRegistry();
  const sourceDigest = migration.digest(SOURCE);
  const plan = migration.buildMigrationPlan({ sources: [{ path: SOURCE_PATH, content: SOURCE }], mapping: mapping({ sourceDigest }) });
  assert.equal(plan.status, 'ready');
  const ledgerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-migration-ledger-'));
  const applied = migration.applyMigration(plan, { registry, ledgerDir, approved: true });
  assert.equal(applied.status, 'committed');
  assert.equal(registry.resolve('jarvOS').record.title, 'jarvOS');
  const project = registry.resolve('jarvOS').record;
  const outcome = registry.resolve('v1.0.0 release').record;
  assert.equal(outcome.parentId, project.id);
  assert.deepEqual(registry.priority(outcome.id), {
    declared: 'unset',
    effective: 'high',
    source: 'inherited',
    sourceRecordId: project.id,
    sourceKind: 'project',
  });
  assert.equal(migration.applyMigration(plan, { registry, ledgerDir, approved: true }).status, 'already_satisfied');
});

test('approved mapping can reconcile explicitly identified canonical records without creating duplicates', () => {
  const registry = makeRegistry();
  const project = registry.create({ title: 'jarvOS', declaredPriority: 'high' }).record;
  const outcome = registry.create({ kind: 'outcome', title: 'v1.0.0 release', parentId: project.id }).record;
  const sourceDigest = migration.digest(SOURCE);
  const plan = migration.buildMigrationPlan({
    sources: [{ path: SOURCE_PATH, content: SOURCE }],
    mapping: {
      ...mapping({ sourceDigest }),
      entries: [{
        ...mapping({ sourceDigest }).entries[0],
        project: { id: project.id, title: 'jarvOS' },
        outcome: { id: outcome.id, title: 'v1.0.0 release', parentId: project.id },
      }],
    },
    migrationId: 'reconcile-canonical-projects',
  });
  const ledgerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-migration-ledger-'));
  const applied = migration.applyMigration(plan, { registry, ledgerDir, approved: true });
  assert.equal(applied.status, 'committed');
  assert.deepEqual(registry.list().map((record) => record.id), [project.id, outcome.id]);
});

test('source drift and incomplete dispositions fail closed before apply', () => {
  assert.throws(() => migration.buildMigrationPlan({ sources: [{ path: SOURCE_PATH, content: SOURCE }], mapping: { version: '1', entries: [{ sourcePath: SOURCE_PATH, project: { title: 'jarvOS' }, fieldDispositions: { title: 'project.title' } }] } }), /field dispositions/);
  const plan = migration.buildMigrationPlan({ sources: [{ path: SOURCE_PATH, content: SOURCE }], mapping: mapping({ sourceDigest: '0'.repeat(64) }) });
  assert.equal(plan.status, 'conflict');
  assert.equal(plan.conflicts[0].reason, 'source-digest-mismatch');
});

test('rollback archives only records named by the migration receipt', () => {
  const registry = makeRegistry();
  const sourceDigest = migration.digest(SOURCE);
  const plan = migration.buildMigrationPlan({ sources: [{ path: SOURCE_PATH, content: SOURCE }], mapping: mapping({ sourceDigest }) });
  const ledgerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-migration-ledger-'));
  migration.applyMigration(plan, { registry, ledgerDir, approved: true });
  const result = migration.rollbackMigration({ ledgerDir, migrationId: plan.migrationId, registry });
  assert.equal(result.status, 'rolled-back');
  assert.equal(registry.list().every((record) => record.lifecycle === 'archived'), true);
});
