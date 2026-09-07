'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const projection = require('../src/journal-projection');

const PROJECTS = [
  { id: 'prj_000001', kind: 'project', title: 'jarvOS', lifecycle: 'active' },
  { id: 'out_000001', kind: 'outcome', title: 'v1.0.0 release', parentId: 'prj_000001', lifecycle: 'active' },
  { id: 'prj_000002', kind: 'project', title: 'Untouched', lifecycle: 'active' },
];

const NOTE_MAPPINGS = {
  prj_000001: { target: 'Projects/jarvOS' },
  prj_000002: { target: 'Projects/Untouched' },
};

test('touched-only projection resolves Outcome activity to the canonical parent Project', () => {
  const result = projection.buildJournalProjection({
    date: '2026-08-08',
    timeZone: 'UTC',
    projects: PROJECTS,
    noteMappings: NOTE_MAPPINGS,
    activities: [
      { canonicalId: 'out_000001', canonicalAtAdmission: { rootProjectId: 'prj_000001' }, occurredAt: '2026-08-08T11:00:00.000Z', trust: 'verified' },
      { canonicalId: 'prj_000002', occurredAt: '2026-08-07T11:00:00.000Z', trust: 'verified' },
    ],
  });
  assert.equal(result.status, 'fresh');
  assert.equal(result.content, '- [[Projects/jarvOS]]');
  assert.deepEqual(result.touchedProjectIds, ['prj_000001']);
});

test('projection never falls back to a Project title when its canonical note mapping is absent', () => {
  const result = projection.buildJournalProjection({
    date: '2026-08-08',
    projects: PROJECTS,
    activities: [{ canonicalId: 'prj_000001', occurredAt: '2026-08-08T11:00:00.000Z', trust: 'verified' }],
    noteMappings: {},
  });
  assert.equal(result.content, null);
  assert.ok(result.omissions.includes('canonical-note-mapping:prj_000001'));
  assert.doesNotMatch(JSON.stringify(result), /jarvOS/);
});

test('projection keeps legacy note targets while displaying canonical root Project titles', () => {
  const result = projection.buildJournalProjection({
    date: '2026-08-08',
    projects: [
      { id: 'prj_000001', kind: 'project', title: 'jarvOS', lifecycle: 'active' },
      { id: 'prj_000002', kind: 'project', title: 'Amazing Abundance Portfolio', lifecycle: 'active' },
      { id: 'prj_000003', kind: 'project', title: 'Amazing Abundance Portfolio', lifecycle: 'active' },
    ],
    noteMappings: {
      prj_000001: { target: 'jarvOS v1.0.0 Release' },
      prj_000002: { target: 'AAF Observatory' },
      prj_000003: { target: 'AAF Observatory' },
    },
    activities: [
      { canonicalId: 'prj_000003', occurredAt: '2026-08-08T13:00:00.000Z', trust: 'verified' },
      { canonicalId: 'prj_000001', occurredAt: '2026-08-08T11:00:00.000Z', trust: 'verified' },
      { canonicalId: 'prj_000002', occurredAt: '2026-08-08T12:00:00.000Z', trust: 'verified' },
    ],
  });
  assert.equal(result.content, [
    '- [[AAF Observatory|Amazing Abundance Portfolio]]',
    '- [[jarvOS v1.0.0 Release|jarvOS]]',
  ].join('\n'));
  assert.deepEqual(result.mappedProjectIds, ['prj_000003', 'prj_000001']);
});

test('projection leaves a mapping unaliased when its target basename is its canonical title', () => {
  const result = projection.buildJournalProjection({
    date: '2026-08-08',
    projects: PROJECTS,
    noteMappings: NOTE_MAPPINGS,
    activities: [{ canonicalId: 'prj_000001', occurredAt: '2026-08-08T11:00:00.000Z', trust: 'verified' }],
  });
  assert.equal(result.content, '- [[Projects/jarvOS]]');
});

test('accepted activity uses its admission-time root and remains visible after archive or reparenting', () => {
  const result = projection.buildJournalProjection({
    date: '2026-08-08',
    projects: [
      { id: 'prj_000001', kind: 'project', title: 'Archived root', lifecycle: 'archived', parentId: null, inference: { disposition: 'quarantined' } },
      { id: 'out_000001', kind: 'outcome', title: 'v1.0.0 release', parentId: 'prj_000002', lifecycle: 'active' },
      { id: 'prj_000002', kind: 'project', title: 'New root', lifecycle: 'active', parentId: null },
    ],
    noteMappings: { prj_000001: { target: 'Projects/Archived-root' }, prj_000002: { target: 'Projects/New-root' } },
    activities: [{
      canonicalId: 'out_000001',
      canonicalAtAdmission: { rootProjectId: 'prj_000001', rootProjectLifecycle: 'active' },
      occurredAt: '2026-08-08T11:00:00.000Z',
      accepted: true,
    }],
  });
  assert.equal(result.content, '- [[Projects/Archived-root|Archived root]]');
  assert.deepEqual(result.touchedProjectIds, ['prj_000001']);
});

test('provisional and quarantined activity cannot create Journal links', () => {
  const result = projection.buildJournalProjection({
    date: '2026-08-08',
    projects: PROJECTS,
    noteMappings: NOTE_MAPPINGS,
    activities: [
      { canonicalId: 'prj_000001', canonicalAtAdmission: { rootProjectId: 'prj_000001' }, disposition: 'provisional', occurredAt: '2026-08-08T11:00:00.000Z', accepted: true },
      { canonicalId: 'prj_000002', canonicalAtAdmission: { rootProjectId: 'prj_000002' }, inference: { disposition: 'quarantined' }, occurredAt: '2026-08-08T11:00:00.000Z', trust: 'verified' },
    ],
  });
  assert.equal(result.status, 'degraded');
  assert.equal(result.preserve, true);
  assert.equal(result.content, null);
  assert.deepEqual(result.touchedProjectIds, []);
});
test('fresh empty evidence removes a stale Projects section while degraded evidence preserves it', () => {
  const empty = projection.buildJournalProjection({ date: '2026-08-08', projects: PROJECTS, noteMappings: NOTE_MAPPINGS, activities: [], activityProviderState: 'healthy-empty' });
  assert.equal(empty.status, 'fresh-empty');
  const original = '---\n\n## 🚀 Projects\n- [[jarvOS]]\n\n## 📝 Notes\n- [[Note]]\n';
  assert.doesNotMatch(projection.replaceProjectsSection(original, empty.content), /## 🚀 Projects/);

  const degraded = projection.buildJournalProjection({ date: '2026-08-08', projects: PROJECTS, noteMappings: NOTE_MAPPINGS, activities: [], activityProviderState: 'partial' });
  assert.equal(degraded.preserve, true);
  const applied = projection.applyJournalProjection({ content: original, projection: degraded, write: () => { throw new Error('must not write'); } });
  assert.equal(applied.status, 'degraded');
  assert.equal(applied.preserve, true);
});

test('context reads do not count as activity and expected revisions fence projection writes', () => {
  const result = projection.buildJournalProjection({
    date: '2026-08-08',
    projects: PROJECTS,
    noteMappings: NOTE_MAPPINGS,
    activities: [{ canonicalId: 'prj_000001', occurredAt: '2026-08-08T11:00:00.000Z', kind: 'context-read' }],
  });
  assert.equal(result.status, 'fresh-empty');
  const content = '## 🚀 Projects\n- [[old]]\n';
  const conflict = projection.applyJournalProjection({ content, expectedRevision: 'stale', projection: result });
  assert.equal(conflict.status, 'conflict');
  const planned = projection.applyJournalProjection({ content, projection: result });
  assert.equal(planned.status, 'planned');
  assert.equal(planned.manifest.priorRevision, projection.digest(content));
});

test('verified context-read events never become project activity', () => {
  const result = projection.buildJournalProjection({
    date: '2026-08-08',
    projects: PROJECTS,
    noteMappings: NOTE_MAPPINGS,
    activities: [{
      canonicalId: 'prj_000001',
      occurredAt: '2026-08-08T11:00:00.000Z',
      category: 'context-read',
      trust: 'verified',
      eventId: 'evt-context-read',
    }],
  });
  assert.equal(result.status, 'fresh-empty');
  assert.equal(result.content, null);
  assert.deepEqual(result.omissions, []);
});

test('malformed same-day activity is explicit and preserves the existing section', () => {
  const result = projection.buildJournalProjection({
    date: '2026-08-08',
    projects: PROJECTS,
    noteMappings: NOTE_MAPPINGS,
    activities: [null],
  });
  assert.equal(result.status, 'degraded');
  assert.equal(result.preserve, true);
  assert.equal(result.content, null);
  assert.deepEqual(result.omissions, ['activity-invalid:0']);
});

test('touched-parent projection is idempotent after its acknowledged content is applied', () => {
  const result = projection.buildJournalProjection({
    date: '2026-08-08', projects: PROJECTS, noteMappings: NOTE_MAPPINGS,
    activities: [{ canonicalId: 'out_000001', canonicalAtAdmission: { rootProjectId: 'prj_000001' }, occurredAt: '2026-08-08T11:00:00.000Z', accepted: true }],
  });
  let writes = 0;
  const first = projection.applyJournalProjection({
    content: '## 📝 Notes\n- [[Note]]\n', projection: result,
    write: () => { writes += 1; return { status: 'acknowledged' }; },
  });
  const retry = projection.applyJournalProjection({ content: first.content, projection: result, write: () => { writes += 1; return { status: 'acknowledged' }; } });
  assert.equal(first.status, 'acknowledged');
  assert.equal(retry.status, 'already_satisfied');
  assert.equal(writes, 1);
  assert.match(retry.content, /\[\[Projects\/jarvOS\]\]/);
});
