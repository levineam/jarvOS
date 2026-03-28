/**
 * bridge.test.js — Unit tests for ontology → Paperclip bridge logic.
 *
 * Tests the planning functions (no network calls).
 * Smoke test for full sync requires live Paperclip (run manually or in CI).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  mapGoalStatus,
  mapProjectStatus,
  planGoalSync,
  planProjectGoalSync,
  loadBridgeState,
  saveBridgeState,
} from '../src/bridge.js';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// ─── Status mapping ────────────────────────────────────────────────────────

describe('mapGoalStatus', () => {
  it('maps Active → active', () => assert.equal(mapGoalStatus('Active'), 'active'));
  it('maps Achieved → achieved', () => assert.equal(mapGoalStatus('Achieved'), 'achieved'));
  it('maps Cancelled → cancelled', () => assert.equal(mapGoalStatus('Cancelled'), 'cancelled'));
  it('maps Stopped → paused', () => assert.equal(mapGoalStatus('Stopped'), 'paused'));
  it('maps Ongoing → active', () => assert.equal(mapGoalStatus('Ongoing'), 'active'));
  it('maps Someday/Long-term → planned', () => assert.equal(mapGoalStatus('Someday/Long-term'), 'planned'));
  it('defaults null → planned', () => assert.equal(mapGoalStatus(null), 'planned'));
  it('defaults unknown → planned', () => assert.equal(mapGoalStatus('WTF'), 'planned'));
});

describe('mapProjectStatus', () => {
  it('maps Active → in_progress', () => assert.equal(mapProjectStatus('Active'), 'in_progress'));
  it('maps Stopped → paused', () => assert.equal(mapProjectStatus('Stopped'), 'paused'));
  it('maps Someday/Long-term → backlog', () => assert.equal(mapProjectStatus('Someday/Long-term'), 'backlog'));
  it('defaults null → backlog', () => assert.equal(mapProjectStatus(null), 'backlog'));
});

// ─── Goal sync planning ───────────────────────────────────────────────────

describe('planGoalSync', () => {
  const ontologyGoals = [
    { id: 'G1', name: 'Goal One', type: 'goal', metadata: { status: 'Active' }, links: [] },
    { id: 'G2', name: 'Goal Two', type: 'goal', metadata: { status: 'Achieved' }, links: [] },
    { id: 'G3', name: 'New Goal', type: 'goal', metadata: { status: 'Active' }, links: [] },
  ];

  it('skips goals already in sync', () => {
    const pcGoals = [
      { id: 'uuid-1', title: 'Goal One', status: 'active', level: 'team' },
    ];
    const state = { goalMap: { G1: 'uuid-1' }, projectMap: {} };
    const plan = planGoalSync(ontologyGoals, pcGoals, state);
    const g1 = plan.find(p => p.ontologyId === 'G1');
    assert.equal(g1.action, 'skip');
  });

  it('updates goals when status changed', () => {
    const pcGoals = [
      { id: 'uuid-2', title: 'Goal Two', status: 'active', level: 'team' },
    ];
    const state = { goalMap: { G2: 'uuid-2' }, projectMap: {} };
    const plan = planGoalSync(ontologyGoals, pcGoals, state);
    const g2 = plan.find(p => p.ontologyId === 'G2');
    assert.equal(g2.action, 'update');
    assert.equal(g2.updates.status, 'achieved');
  });

  it('creates goals with no mapping or title match', () => {
    const pcGoals = [];
    const state = { goalMap: {}, projectMap: {} };
    const plan = planGoalSync(ontologyGoals, pcGoals, state);
    const g3 = plan.find(p => p.ontologyId === 'G3');
    assert.equal(g3.action, 'create');
    assert.equal(g3.data.title, 'New Goal');
    assert.equal(g3.data.level, 'team');
  });

  it('adopts existing goal by title match', () => {
    const pcGoals = [
      { id: 'uuid-match', title: 'Goal One', status: 'planned', level: 'team' },
    ];
    const state = { goalMap: {}, projectMap: {} };
    const plan = planGoalSync([ontologyGoals[0]], pcGoals, state);
    const g1 = plan.find(p => p.ontologyId === 'G1');
    assert.equal(g1.action, 'adopt');
    assert.equal(g1.paperclipId, 'uuid-match');
  });

  it('flags error for stale mapping', () => {
    const pcGoals = []; // uuid-1 is gone
    const state = { goalMap: { G1: 'uuid-1' }, projectMap: {} };
    const plan = planGoalSync(ontologyGoals, pcGoals, state);
    const g1 = plan.find(p => p.ontologyId === 'G1');
    assert.equal(g1.action, 'error');
    assert.match(g1.reason, /not found/);
  });
});

// ─── Project goal sync planning ───────────────────────────────────────────

describe('planProjectGoalSync', () => {
  it('updates project goal linkage from serves-links', () => {
    const ontologyProjects = [
      {
        id: 'PJ1', name: 'Test Project', type: 'project',
        metadata: { status: 'Active' },
        links: [{ type: 'serves', target: 'G2', targetId: 'G2' }],
      },
    ];
    const pcProjects = [
      { id: 'proj-uuid', name: 'Test Project', status: 'in_progress', goalId: null, goalIds: [] },
    ];
    const state = { goalMap: { G2: 'goal-uuid-2' }, projectMap: {} };

    const plan = planProjectGoalSync(ontologyProjects, pcProjects, state);
    const pj1 = plan.find(p => p.ontologyId === 'PJ1');
    assert.equal(pj1.action, 'update-goals');
    assert.deepEqual(pj1.goalIds, ['goal-uuid-2']);
  });

  it('skips when no Paperclip project matches', () => {
    const ontologyProjects = [
      { id: 'PJ1', name: 'No Match', type: 'project', metadata: {}, links: [] },
    ];
    const pcProjects = [
      { id: 'proj-uuid', name: 'Different Name', status: 'in_progress', goalId: null },
    ];
    const state = { goalMap: {}, projectMap: {} };

    const plan = planProjectGoalSync(ontologyProjects, pcProjects, state);
    assert.equal(plan[0].action, 'skip');
    assert.match(plan[0].reason, /No matching/);
  });
});

// ─── Bridge state persistence ─────────────────────────────────────────────

describe('bridge-state.json persistence', () => {
  it('roundtrips correctly', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'bridge-test-'));
    try {
      const state = {
        goalMap: { G1: 'uuid-1' },
        projectMap: { PJ1: 'proj-1' },
        lastSyncAt: '2026-03-20T00:00:00Z',
        syncLog: [{ at: '2026-03-20T00:00:00Z', note: 'test' }],
      };
      saveBridgeState(tmp, state);
      const loaded = loadBridgeState(tmp);
      assert.deepEqual(loaded.goalMap, state.goalMap);
      assert.deepEqual(loaded.projectMap, state.projectMap);
      assert.equal(loaded.lastSyncAt, state.lastSyncAt);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('returns empty state when file missing', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'bridge-empty-'));
    try {
      const loaded = loadBridgeState(tmp);
      assert.deepEqual(loaded.goalMap, {});
      assert.deepEqual(loaded.projectMap, {});
      assert.equal(loaded.lastSyncAt, null);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
