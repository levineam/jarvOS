'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const projection = require('../src/journal-projection');

const PROJECTS = [
  { id: 'prj_000001', kind: 'project', title: 'jarvOS', lifecycle: 'active' },
  { id: 'out_000001', kind: 'outcome', title: 'v1.0.0 release', parentId: 'prj_000001', lifecycle: 'active' },
  { id: 'prj_000002', kind: 'project', title: 'Untouched', lifecycle: 'active' },
];

test('touched-only projection resolves Outcome activity to the canonical parent Project', () => {
  const result = projection.buildJournalProjection({
    date: '2026-08-08',
    timeZone: 'UTC',
    projects: PROJECTS,
    activities: [
      { canonicalId: 'out_000001', occurredAt: '2026-08-08T11:00:00.000Z', trust: 'verified' },
      { canonicalId: 'prj_000002', occurredAt: '2026-08-07T11:00:00.000Z', trust: 'verified' },
      { canonicalId: 'prj_000002', occurredAt: '2026-08-08T11:00:00.000Z', trust: 'unverified' },
    ],
  });
  assert.equal(result.status, 'fresh');
  assert.equal(result.content, '- [[jarvOS]]');
  assert.deepEqual(result.touchedProjectIds, ['prj_000001']);
});
test('fresh empty evidence removes a stale Projects section while degraded evidence preserves it', () => {
  const empty = projection.buildJournalProjection({ date: '2026-08-08', projects: PROJECTS, activities: [], activityProviderState: 'healthy-empty' });
  assert.equal(empty.status, 'fresh-empty');
  const original = '---\n\n## 🚀 Projects\n- [[jarvOS]]\n\n## 📝 Notes\n- [[Note]]\n';
  assert.doesNotMatch(projection.replaceProjectsSection(original, empty.content), /## 🚀 Projects/);

  const degraded = projection.buildJournalProjection({ date: '2026-08-08', projects: PROJECTS, activities: [], activityProviderState: 'partial' });
  assert.equal(degraded.preserve, true);
  const applied = projection.applyJournalProjection({ content: original, projection: degraded, write: () => { throw new Error('must not write'); } });
  assert.equal(applied.status, 'degraded');
  assert.equal(applied.preserve, true);
});

test('context reads do not count as activity and expected revisions fence projection writes', () => {
  const result = projection.buildJournalProjection({
    date: '2026-08-08',
    projects: PROJECTS,
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
