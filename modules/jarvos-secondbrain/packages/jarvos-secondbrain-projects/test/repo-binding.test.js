'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  REPO_OBSERVATION_CONTRACT,
  bindingToken,
  createRepoBinding,
  createRepoObservation,
  normalizeBranch,
  normalizeRemote,
  resolveRepoBinding,
  validateRepoBinding,
} = require('../src/repo-binding');

const SECRET = 'repo-binding-test-secret';
const repo = (key) => bindingToken('repository', key, SECRET);

test('normalizes equivalent remote spellings and strips credentials', () => {
  const expected = 'github.com/levineam/fx-alpha';
  for (const remote of [
    'https://github.com/levineam/fx-alpha.git',
    ['https://user:', ['gh', 'p', '_fixture-value'].join(''), '@github.com/LevineAM/fx-alpha'].join(''),
    'ssh://git@github.com:22/levineam/fx-alpha.git',
    'git@github.com:levineam/fx-alpha.git',
  ]) assert.equal(normalizeRemote(remote), expected, remote);
  assert.equal(normalizeRemote('/Users/example/fx-alpha'), null);
  assert.equal(normalizeRemote('https://github.com/../x'), null);
  assert.equal(normalizeRemote('not a remote'), null);
  assert.equal(normalizeBranch('refs/heads/feature/a'), 'feature/a');
  assert.equal(normalizeBranch('HEAD'), null);
  assert.equal(normalizeBranch('bad..name'), null);
});

test('tokens are host-keyed, domain-separated, and never echo their input', () => {
  const token = bindingToken('repository', 'github.com/levineam/fx-alpha', SECRET);
  assert.match(token, /^[a-f0-9]{64}$/);
  assert.notEqual(token, bindingToken('branch', 'github.com/levineam/fx-alpha', SECRET));
  assert.notEqual(token, bindingToken('repository', 'github.com/levineam/fx-alpha', 'other-secret'));
  assert.throws(() => bindingToken('repository', 'x', ''), /secret/);
  const observation = createRepoObservation({ repositoryKey: 'github.com/levineam/fx-alpha', worktreeKey: '/tmp/wt', branch: 'main' }, SECRET);
  assert.equal(observation.contract, REPO_OBSERVATION_CONTRACT);
  assert.equal(JSON.stringify(observation).includes('/tmp/wt'), false);
  assert.equal(JSON.stringify(observation).includes('levineam'), false);
});

test('bindings carry at most one qualifier and exact keys', () => {
  assert.throws(() => createRepoBinding({ canonicalId: 'prj_000001', repositoryDigest: repo('a'), branchDigest: repo('b'), pullRequest: 3 }), /at most one qualifier/);
  assert.throws(() => validateRepoBinding({ ...createRepoBinding({ canonicalId: 'prj_000001', repositoryDigest: repo('a') }), path: '/x' }), /unsupported/);
  assert.throws(() => createRepoBinding({ canonicalId: 'project-1', repositoryDigest: repo('a') }), /canonicalId/);
});

test('precedence is worktree, then pull request, then branch, then single unqualified repository', () => {
  const bindings = [
    createRepoBinding({ canonicalId: 'prj_000001', repositoryDigest: repo('shared') }),
    createRepoBinding({ canonicalId: 'prj_000002', repositoryDigest: repo('shared'), branchDigest: bindingToken('branch', 'feature/a', SECRET) }),
    createRepoBinding({ canonicalId: 'prj_000003', repositoryDigest: repo('shared'), pullRequest: 9 }),
    createRepoBinding({ canonicalId: 'prj_000004', repositoryDigest: repo('shared'), worktreeDigest: bindingToken('worktree', 'wt-pinned', SECRET) }),
  ];
  const observe = (fields) => createRepoObservation({ repositoryKey: 'shared', ...fields }, SECRET);
  assert.deepEqual(resolveRepoBinding({ bindings, observation: observe({ worktreeKey: 'wt-pinned', branch: 'feature/a', pullRequest: 9 }) }), { status: 'bound', reason: null, tier: 'worktree', canonicalId: 'prj_000004' });
  assert.equal(resolveRepoBinding({ bindings, observation: observe({ branch: 'feature/a', pullRequest: 9 }) }).canonicalId, 'prj_000003');
  assert.equal(resolveRepoBinding({ bindings, observation: observe({ branch: 'feature/a' }) }).canonicalId, 'prj_000002');
  assert.equal(resolveRepoBinding({ bindings, observation: observe({ branch: 'main' }) }).canonicalId, 'prj_000001');
});

test('unmapped, shared-unqualified, ambiguous, and invalid observations stay unattributed', () => {
  const shared = [
    createRepoBinding({ canonicalId: 'prj_000002', repositoryDigest: repo('shared'), branchDigest: bindingToken('branch', 'feature/a', SECRET) }),
    createRepoBinding({ canonicalId: 'prj_000003', repositoryDigest: repo('shared'), branchDigest: bindingToken('branch', 'feature/b', SECRET) }),
  ];
  const observe = (key, fields = {}) => createRepoObservation({ repositoryKey: key, ...fields }, SECRET);
  assert.deepEqual(resolveRepoBinding({ bindings: shared, observation: observe('elsewhere') }), { status: 'unattributed', reason: 'unmapped', tier: null, canonicalId: null });
  assert.equal(resolveRepoBinding({ bindings: shared, observation: observe('shared', { branch: 'main' }) }).reason, 'unqualified');
  assert.equal(resolveRepoBinding({ bindings: shared, observation: observe('shared') }).reason, 'unqualified');
  const duplicated = [...shared, createRepoBinding({ canonicalId: 'prj_000009', repositoryDigest: repo('shared'), branchDigest: bindingToken('branch', 'feature/a', SECRET) })];
  assert.deepEqual(resolveRepoBinding({ bindings: duplicated, observation: observe('shared', { branch: 'feature/a' }) }), { status: 'unattributed', reason: 'ambiguous', tier: 'branch', canonicalId: null });
  const twoUnqualified = [
    createRepoBinding({ canonicalId: 'prj_000005', repositoryDigest: repo('dual') }),
    createRepoBinding({ canonicalId: 'prj_000006', repositoryDigest: repo('dual') }),
  ];
  assert.equal(resolveRepoBinding({ bindings: twoUnqualified, observation: observe('dual') }).reason, 'ambiguous');
  assert.equal(resolveRepoBinding({ bindings: shared, observation: { repositoryDigest: repo('shared') } }).reason, 'invalid');
  assert.equal(resolveRepoBinding({ bindings: [{ bogus: true }], observation: observe('shared') }).reason, 'invalid');
});

test('a linked worktree resolves to the same Project as its primary checkout', () => {
  const bindings = [createRepoBinding({ canonicalId: 'prj_000007', repositoryDigest: repo('/private/common/.git') })];
  const primary = createRepoObservation({ repositoryKey: '/private/common/.git', worktreeKey: '/private/primary', branch: 'main' }, SECRET);
  const linked = createRepoObservation({ repositoryKey: '/private/common/.git', worktreeKey: '/private/linked', branch: 'topic' }, SECRET);
  assert.notEqual(primary.worktreeDigest, linked.worktreeDigest);
  assert.equal(resolveRepoBinding({ bindings, observation: primary }).canonicalId, 'prj_000007');
  assert.equal(resolveRepoBinding({ bindings, observation: linked }).canonicalId, 'prj_000007');
});
