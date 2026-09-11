'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { ProjectRegistry } = require('../src/registry');
const { buildContextPacket, buildCanonicalRosterPacket } = require('../src/projects-context');
const { issueCapability } = require('../src/projects-context-capability');

const NOW = '2026-09-11T12:00:00.000Z';
const SECRET = 'roster-test-only-secret';

function fixture(t, count = 12) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'projects-roster-'));
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  const registry = new ProjectRegistry({ stateDir, now: () => NOW });
  for (let i = 0; i < count; i += 1) {
    registry.create({ title: `Project ${String(i).padStart(2, '0')}`, definitionOfDone: 'Long accepted criteria. '.repeat(100) });
  }
  return { registry, stateDir };
}

function input(registry, changes = {}) {
  const query = {
    scope: { projectIds: [], outcomeIds: [], includeDescendants: true },
    include: ['hierarchy', 'activity', 'currentWork', 'attention'],
    limits: { maxItems: 24, maxBytes: 16000, maxProviderAgeSeconds: 3600 },
    ...changes,
  };
  const capability = issueCapability({
    authorization: { allowed: true }, hostId: 'roster-host', hostSecret: SECRET,
    subject: 'roster-observer', query, scope: query.scope, limits: query.limits,
    redactionClass: 'private', providerCoverage: [], capabilityRevision: 'roster-test-1',
    issuedAt: NOW, expiresAt: '2026-09-11T13:00:00.000Z', nonce: 'roster-test',
  });
  return { registry, query, capability, capabilitySecret: SECRET, subject: 'roster-observer', hostId: 'roster-host', now: NOW };
}

test('characterization: ordinary orientation legitimately truncates verbose canonical records', (t) => {
  const { registry } = fixture(t);
  const out = buildContextPacket(input(registry));
  assert.equal(out.status, 'ok');
  assert.equal(out.packet.truncation.truncated, true);
  assert.ok(out.packet.truncation.sections.includes('canonical.records'));
  assert.ok(out.packet.canonical.records.length < registry.list().length);
  assert.ok(Buffer.byteLength(JSON.stringify(out.packet)) <= 16000);
});

test('compact roster returns every unique canonical identity without verbose orientation content', (t) => {
  const { registry } = fixture(t);
  const before = registry.snapshot();
  const out = buildCanonicalRosterPacket(input(registry));
  assert.equal(out.status, 'ok');
  assert.equal(out.roster.contract, 'jarvos.projects-roster/v1');
  assert.equal(out.roster.complete, true);
  assert.equal(out.roster.generation, registry.generation);
  assert.deepEqual(out.roster.records.map((r) => r.id), registry.list().map((r) => r.id).sort());
  assert.equal(new Set(out.roster.records.map((r) => r.id)).size, 12);
  assert.deepEqual(Object.keys(out.roster.records[0]).sort(), ['id', 'kind', 'parentId', 'revision']);
  assert.ok(Buffer.byteLength(JSON.stringify(out)) <= 16000);
  assert.deepEqual(registry.snapshot(), before);
});

test('roster preserves exact signed scope and includes only its descendants', (t) => {
  const { registry } = fixture(t, 2);
  const root = registry.list()[0];
  const child = registry.create({ title: 'Child', kind: 'outcome', parentId: root.id }).record;
  const nestedProject = registry.create({ title: 'Nested project', parentId: root.id }).record;
  const args = input(registry, { scope: { projectIds: [root.id], outcomeIds: [], includeDescendants: true } });
  const out = buildCanonicalRosterPacket(args);
  assert.equal(out.status, 'ok');
  assert.deepEqual(out.roster.records.map((r) => r.id).sort(), [root.id, child.id, nestedProject.id].sort());
  assert.deepEqual(out.roster.scope, args.query.scope);
  assert.notEqual(buildCanonicalRosterPacket({ ...args, query: input(registry).query }).status, 'ok');
  assert.notEqual(buildCanonicalRosterPacket({ ...args, capabilitySecret: 'wrong' }).status, 'ok');
  assert.notEqual(buildCanonicalRosterPacket({ ...args, subject: 'another-observer' }).status, 'ok');
});

test('roster never declares oversized scope complete or silently paginates', (t) => {
  const { registry } = fixture(t, 4);
  const out = buildCanonicalRosterPacket(input(registry, { limits: { maxItems: 2, maxBytes: 512, maxProviderAgeSeconds: 3600 } }));
  assert.equal(out.status, 'incomplete');
  assert.equal(out.roster.complete, false);
  assert.deepEqual(out.roster.records, []);
  assert.ok(Buffer.byteLength(JSON.stringify(out)) <= 512);
  assert.notEqual(buildCanonicalRosterPacket({ ...input(registry), continuation: 'invented' }).status, 'ok');
});

test('roster rejects an expected generation mismatch and mid-collection generation change', (t) => {
  const { registry } = fixture(t, 2);
  assert.notEqual(buildCanonicalRosterPacket({ ...input(registry), expectedGeneration: registry.generation - 1 }).status, 'ok');
  const list = registry.list.bind(registry);
  const changing = {
    generation: registry.generation,
    get: registry.get.bind(registry),
    list() { this.generation += 1; return list(); },
  };
  assert.notEqual(buildCanonicalRosterPacket(input(changing)).status, 'ok');
});

test('roster limits total collection work and sanitizes unreadable sources', (t) => {
  const { registry } = fixture(t, 1);
  const row = registry.list()[0];
  let reads = 0;
  const oversized = { generation: 1, list() { reads += 1; return Array.from({ length: 1001 }, (_, i) => ({ ...row, id: `prj_${String(i + 1).padStart(6, '0')}` })); } };
  const out = buildCanonicalRosterPacket(input(oversized));
  assert.notEqual(out.status, 'ok');
  assert.ok(reads <= 1);
  const broken = { generation: 1, list() { throw new Error('secret-bearing raw source failure'); } };
  const failed = buildCanonicalRosterPacket(input(broken));
  assert.notEqual(failed.status, 'ok');
  assert.ok(!JSON.stringify(failed).includes('secret-bearing'));
});

test('roster requires explicit subject binding and rejects structurally inconsistent identities', (t) => {
  const { registry } = fixture(t, 1);
  assert.notEqual(buildCanonicalRosterPacket({ ...input(registry), subject: undefined }).status, 'ok');
  const row = registry.list()[0];
  const inconsistent = { generation: 1, list: () => [{ ...row, kind: 'outcome' }] };
  assert.notEqual(buildCanonicalRosterPacket(input(inconsistent)).status, 'ok');
});

test('roster sanitizes a generation read that fails after collection', (t) => {
  const { registry } = fixture(t, 1);
  let reads = 0;
  const broken = {
    get generation() { reads += 1; if (reads > 1) throw new Error('private generation failure'); return 1; },
    list: () => registry.list(),
  };
  const out = buildCanonicalRosterPacket(input(broken));
  assert.notEqual(out.status, 'ok');
  assert.ok(!JSON.stringify(out).includes('private generation failure'));
});
