'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  PROFILE_CONTRACT,
  PROFILE_REVISION,
  resolveQueryProfile,
  validateQueryProfile,
} = require('../src/projects-context-profiles.js');
const { filterSummariesByWindow } = require('../src/projects-context.js');

const SCOPE = { projectIds: ['prj_000001'], outcomeIds: ['out_000001'], includeDescendants: true };

test('orientation profile produces one bounded host-issued query shape', () => {
  const profile = resolveQueryProfile('orientation', { scope: SCOPE, authorizedScope: true });
  assert.equal(profile.contract, PROFILE_CONTRACT);
  assert.equal(profile.revision, PROFILE_REVISION);
  assert.equal(profile.scopeOrigin, 'host-authorized');
  assert.deepEqual(profile.query.include, ['hierarchy', 'activity', 'currentWork', 'attention']);
  assert.equal(profile.activityWindow, null);
  assert.deepEqual(validateQueryProfile(profile), { ok: true, profile });
});

test('recent-activity profile resolves a local calendar day before packet truncation', () => {
  const profile = resolveQueryProfile('recent-activity', {
    scope: SCOPE,
    date: '2026-08-12',
    timeZone: 'America/New_York',
    now: new Date('2026-08-13T02:00:00.000Z'),
  });
  assert.equal(profile.activityWindow.localDate, '2026-08-12');
  assert.equal(profile.activityWindow.from, '2026-08-12T04:00:00.000Z');
  assert.equal(profile.activityWindow.to, '2026-08-13T04:00:00.000Z');
  assert.deepEqual(validateQueryProfile(profile), { ok: true, profile });
});

test('profiles reject unknown names and unscoped caller requests', () => {
  assert.throws(() => resolveQueryProfile('portfolio'), /unknown/);
  assert.throws(() => resolveQueryProfile('orientation'), /scope is required/);
  const hostDefault = resolveQueryProfile('orientation', { authorizedScope: true });
  assert.deepEqual(hostDefault.query.scope, { projectIds: [], outcomeIds: [], includeDescendants: true });
  assert.equal(validateQueryProfile({ ...hostDefault, query: { ...hostDefault.query, limits: { ...hostDefault.query.limits, maxItems: 1 } } }).ok, false);
});

test('session-focus is a host-only bounded hierarchy profile: caller-supplied scope is rejected, host-authorized scope resolves hierarchy-only', () => {
  assert.throws(() => resolveQueryProfile('session-focus', { scope: SCOPE }), /host-authorized scope/);
  const profile = resolveQueryProfile('session-focus', { scope: SCOPE, authorizedScope: true });
  assert.equal(profile.scopeOrigin, 'host-authorized');
  assert.deepEqual(profile.query.include, ['hierarchy']);
  assert.deepEqual(validateQueryProfile(profile), { ok: true, profile });
});

test('activity windows filter by occurrence time rather than provider capture order', () => {
  const rows = [
    { id: 'a', occurredAt: '2026-08-12T03:59:59.000Z' },
    { id: 'b', occurredAt: '2026-08-12T04:00:00.000Z' },
    { id: 'c', occurredAt: '2026-08-13T03:59:59.999Z' },
    { id: 'd', occurredAt: '2026-08-13T04:00:00.000Z' },
    { id: 'e', occurredAt: null },
  ];
  assert.deepEqual(filterSummariesByWindow(rows, {
    from: '2026-08-12T04:00:00.000Z',
    to: '2026-08-13T04:00:00.000Z',
    localDate: '2026-08-12',
    timeZone: 'America/New_York',
  }).map((row) => row.id), ['b', 'c']);
});
