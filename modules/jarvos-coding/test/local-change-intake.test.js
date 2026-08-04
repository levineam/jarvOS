'use strict';

const assert = require('assert');
const test = require('node:test');

const { assessLocalChange } = require('../src');

function catalogEntry(overrides = {}) {
  return {
    id: 'jarvos',
    ownership: 'jarvos-owned',
    distribution: 'core',
    defaultVisibility: 'public',
    localChangePolicy: 'default-public',
    integrationImpactPolicy: 'direct',
    ignoredPathPolicy: 'git-default',
    ...overrides,
  };
}

function repository(overrides = {}) {
  return {
    canonicalId: 'github:levineam/jarvOS',
    baseRef: 'main',
    branch: 'feat/todo-list',
    worktreeId: 'worktree-a',
    changedPaths: ['modules/jarvos-todos/src/index.js'],
    ...overrides,
  };
}

test('jarvOS local work produces a stable public-eligible release proposal without source content', () => {
  const assessment = assessLocalChange({ repository: repository(), catalogEntry: catalogEntry() });

  assert.equal(assessment.eventType, 'local_change_detected');
  assert.equal(assessment.route.kind, 'jarvos-release-proposal');
  assert.equal(assessment.publicRouting.blocked, false);
  assert.ok(assessment.changeSet.id.startsWith('change-set:'));
  assert.deepEqual(assessment.evidence.changedPaths, ['modules/jarvos-todos/src/index.js']);
  assert.equal('source' in assessment.evidence, false);
});

test('rebase and worktree churn retain a change-set identity and add aliases', () => {
  const first = assessLocalChange({ repository: repository(), catalogEntry: catalogEntry() });
  const rebased = assessLocalChange({
    repository: repository({ branch: 'feat/todo-list-rebased', worktreeId: 'worktree-b' }),
    catalogEntry: catalogEntry(),
  });

  assert.equal(first.changeSet.id, rebased.changeSet.id);
  assert.notDeepEqual(first.changeSet.aliases, rebased.changeSet.aliases);
});

test('unknown repositories and generated-only changes do not create public routes', () => {
  const unknown = assessLocalChange({ repository: repository(), catalogEntry: null });
  const generated = assessLocalChange({
    repository: repository({ changedPaths: ['node_modules/example/index.js', 'dist/bundle.js'] }),
    catalogEntry: catalogEntry(),
  });

  assert.equal(unknown.route.kind, 'relationship-needed');
  assert.equal(unknown.publicRouting.blocked, true);
  assert.equal(generated.eventType, 'no_local_change');
  assert.equal(generated.route.kind, 'none');
});

test('required secret scanning fails closed with bounded reason codes', () => {
  const assessment = assessLocalChange({
    repository: repository(),
    catalogEntry: catalogEntry(),
    privacyScan: { required: true, status: 'match', reasonCodes: ['secret-pattern'] },
  });

  assert.equal(assessment.publicRouting.blocked, true);
  assert.equal(assessment.publicRouting.reason, 'privacy-scan-match');
  assert.deepEqual(assessment.privacy.reasonCodes, ['secret-pattern']);
});

test('unmerged local branches are part of the intake without exposing checkout paths', () => {
  const assessment = assessLocalChange({
    repository: repository({
      changedPaths: [],
      integrationBranch: 'main',
      unmergedBranches: [
        { name: 'feat/one', commits: ['a1', 'a2'] },
        { name: 'fix/two', commits: ['b1'] },
      ],
    }),
    catalogEntry: catalogEntry(),
  });

  assert.equal(assessment.eventType, 'local_change_detected');
  assert.equal(assessment.repository.integrationBranch, 'main');
  assert.equal(assessment.evidence.unmergedBranchCount, 2);
  assert.equal(assessment.evidence.unmergedCommitCount, 3);
  assert.ok(assessment.changeSet.id.startsWith('change-set:'));
  assert.equal(JSON.stringify(assessment).includes('worktree-a'), false);
});
