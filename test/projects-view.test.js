'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { normalizeProjectsResult } = require('../server/adapters/projects-context');
const projectsView = require('../static/projects-view');

function result(overrides = {}) {
  return {
    status: 'ok',
    packet: {
      capturedAt: '2026-09-09T12:00:00.000Z',
      expiresAt: '2026-09-09T13:00:00.000Z',
      query: { scope: { projectIds: ['prj_1'], outcomeIds: ['out_1'], includeDescendants: true } },
      canonical: { records: [
        { id: 'prj_1', kind: 'project', title: 'jarvOS <Desktop>', lifecycle: 'active', goal: 'Build it' },
        { id: 'out_1', kind: 'outcome', parentId: 'prj_1', title: 'Accepted UI', definitionOfDone: 'Reader acceptance' },
      ] },
      attention: [{ canonicalId: 'out_1', title: 'Verify the rendered result' }],
      omissions: ['Beads evidence unavailable'],
      ...overrides,
    },
  };
}

test('Projects preserves provider scope, timestamps, outcome, definition, and omissions', () => {
  const data = normalizeProjectsResult(result());
  assert.equal(data.status, 'ok');
  assert.equal(data.coverage, 'partial');
  assert.deepEqual(data.scope.projectIds, ['prj_1']);
  assert.equal(data.capturedAt, '2026-09-09T12:00:00.000Z');
  assert.equal(data.projects[0].outcome, 'Accepted UI');
  assert.equal(data.projects[0].definitionOfDone, 'Reader acceptance');
  assert.equal(data.projects[0].nextStep, 'Verify the rendered result');
  assert.deepEqual(data.projects[0].completionEvidence, []);
});

test('Projects view labels missing evidence and escapes provider text', () => {
  const html = projectsView.render(normalizeProjectsResult(result()), 'prj_1');
  assert.match(html, /Completion evidence unavailable/);
  assert.match(html, /jarvOS &lt;Desktop&gt;/);
  assert.doesNotMatch(html, /jarvOS <Desktop>/);
  assert.match(html, /Partial provider scope/);
});

test('stale, unavailable, and empty provider states remain honest', () => {
  const stale = normalizeProjectsResult({ status: 'unavailable', code: 'PROJECTS_CONTEXT_STALE', reason: 'Provider data is stale' });
  assert.match(projectsView.render(stale), /cannot be verified right now/);
  assert.match(projectsView.render(stale), /no registry fallback used/);
  const empty = normalizeProjectsResult(result({ canonical: { records: [] } }));
  assert.match(projectsView.render(empty), /No admitted projects/);
});
