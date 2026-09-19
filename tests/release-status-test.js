#!/usr/bin/env node
'use strict';

const assert = require('assert/strict');
const { EventEmitter } = require('events');
const test = require('node:test');

const {
  observeReleaseStatus,
  renderHuman,
  parseArgs,
  githubRequest,
} = require('../scripts/lib/release-status');
const { createProductionChecks } = require('../scripts/release-status');

function adapters(overrides = {}) {
  return {
    git: {
      resolveRef: (ref) => ({ ref, sha: 'a'.repeat(40) }),
      isReachableFrom: () => true,
      tagForSha: () => null,
      headSha: () => 'a'.repeat(40),
      isClean: () => true,
      prepareVerification: () => ({ root: null, env: {}, npmPath: 'npm', cleanup: () => {} }),
      commitDistance: () => 17,
      ...overrides.git,
    },
    github: {
      latestRelease: () => ({ tagName: 'v0.7.0', publishedAt: '2026-08-01T00:00:00.000Z' }),
      releaseByTag: () => null,
      sourceRefSha: () => 'a'.repeat(40),
      ...overrides.github,
    },
    checks: {
      drift: () => ({ state: 'ok', drift: false, messages: ['tracked under [Unreleased]'] }),
      readiness: () => ({ ok: false, results: [
        { ok: false, label: 'package.json version', detail: 'package.json has 0.7.0; target is 1.0.0' },
        { ok: true, label: 'smoke test', detail: 'npm test passed' },
      ] }),
      ...overrides.checks,
    },
  };
}

function observe(options = {}, overrides = {}) {
  return observeReleaseStatus({
    version: '1.0.0',
    sourceRef: 'origin/main',
    repository: 'levineam/jarvOS',
    protectedBranch: 'origin/main',
    now: () => '2026-08-13T12:00:00.000Z',
    ...adapters(overrides),
    ...options,
  });
}

test('a current not-ready release is a verified successful observation with current findings', () => {
  const result = observe({ verify: true });

  assert.equal(result.contract, 'jarvos.release-observation/v1');
  assert.equal(result.availability, 'available');
  assert.equal(result.source.resolvedSha, 'a'.repeat(40));
  assert.equal(result.source.commitDistance, 17);
  assert.equal(result.publication.published, false);
  assert.equal(result.publication.latestPublicVersion, '0.7.0');
  assert.equal(result.readiness.status, 'not-ready');
  assert.equal(result.verification.coverage, 'verified');
  assert.deepEqual(result.omissions, []);
  assert.deepEqual(result.findings, ['package.json version: package.json has 0.7.0; target is 1.0.0']);
});

test('passing gates remove stale findings and GitHub latest-public facts come from the current adapter result', () => {
  const result = observe({ verify: true }, {
    github: { latestRelease: () => ({ tagName: 'v0.9.0', publishedAt: '2026-08-12T00:00:00.000Z' }) },
    checks: { readiness: () => ({ ok: true, results: [{ ok: true, label: 'smoke test', detail: 'npm test passed' }] }) },
  });

  assert.equal(result.publication.latestPublicVersion, '0.9.0');
  assert.equal(result.readiness.status, 'ready');
  assert.deepEqual(result.findings, []);
});

test('component-prefixed Release Please tags retain their raw tag and normalize only the semantic version', () => {
  const result = observe({ version: '0.8.0', verify: true }, {
    git: { tagForSha: (_sha, tag) => tag === 'jarvos-bootstrap-v0.8.0' ? tag : null },
    github: {
      latestRelease: () => ({ tagName: 'jarvos-bootstrap-v0.8.0', publishedAt: '2026-08-16T00:00:00.000Z' }),
      releaseByTag: () => null,
    },
    checks: { readiness: () => ({ ok: true, results: [] }) },
  });

  assert.equal(result.publication.published, true);
  assert.equal(result.publication.latestPublicVersion, '0.8.0');
  assert.equal(result.publication.latestRelease.tag, 'jarvos-bootstrap-v0.8.0');
  assert.equal(result.publication.targetRelease.tag, 'jarvos-bootstrap-v0.8.0');
  assert.equal(result.publication.localTag, 'jarvos-bootstrap-v0.8.0');
  assert.deepEqual(result.findings, []);
});

const V011_TAG = 'jarvos-bootstrap-v0.11.0';
const v011Published = () => ({ tagName: V011_TAG, publishedAt: '2026-09-19T00:00:00.000Z' });

function observeV011(options = {}, overrides = {}) {
  return observe({ version: '0.11.0', sourceRef: V011_TAG, verify: true, ...options }, {
    git: { tagForSha: (_sha, tag) => tag === V011_TAG ? tag : null },
    github: { latestRelease: v011Published },
    checks: { readiness: () => ({ ok: true, results: [] }) },
    ...overrides,
  });
}

test('v0.11 post-publication observes the prefixed tag as the published baseline without synthesizing a plain tag', () => {
  const probedTags = [];
  let readinessOptions;
  const result = observeV011({}, {
    github: { latestRelease: v011Published, releaseByTag: (_repository, tag) => { probedTags.push(tag); return null; } },
    checks: { readiness: (options) => { readinessOptions = options; return { ok: true, results: [] }; } },
  });

  assert.equal(result.availability, 'available');
  assert.equal(result.readiness.status, 'ready');
  assert.deepEqual(result.findings, []);
  assert.equal(result.target.tag, V011_TAG);
  assert.equal(result.target.role, 'published-baseline');
  assert.equal(result.publication.published, true);
  assert.equal(result.publication.targetRelease.tag, V011_TAG);
  assert.equal(result.publication.localTag, V011_TAG);
  assert.deepEqual(result.lanes.baseline, { status: 'published', version: '0.11.0', tag: V011_TAG, publishedAt: '2026-09-19T00:00:00.000Z' });
  assert.equal(result.lanes.candidate.status, 'none');
  assert.equal(result.lanes.future, null);
  assert.equal(readinessOptions.allowExistingTag, true, 'a published tag must not fail the tag preflight');
  assert.deepEqual(probedTags, ['v0.11.0', V011_TAG], 'only approved names are probed, never created');
  assert.equal(JSON.stringify([result.target, result.publication, result.lanes]).includes('"v0.11.0"'), false, 'no plain tag GitHub did not publish');
});

test('a package-prefixed source ref for another package is still rejected', () => {
  const result = observeV011({ sourceRef: 'other-package-v0.11.0' });
  assert.equal(result.availability, 'unavailable');
  assert.equal(result.failure.code, 'SOURCE_POLICY_REJECTED');
});

test('baseline, Release Please candidate, and the future clean-machine lane stay distinct', () => {
  const futureLane = { kind: 'clean-machine', version: '1.0.0', ref: 'legacy-clean-machine-lane' };
  const candidate = { status: 'present', version: '0.11.1', source: 'release-please-pr' };
  const overrides = {
    github: { latestRelease: v011Published },
    checks: { readiness: () => ({ ok: true, results: [] }) },
  };

  const future = observe({ version: '1.0.0', verify: true, candidate, futureLane }, overrides);
  assert.equal(future.lanes.baseline.version, '0.11.0');
  assert.deepEqual(future.lanes.candidate, { status: 'present', version: '0.11.1', source: 'release-please-pr' });
  assert.deepEqual(future.lanes.future, { status: 'future', kind: 'clean-machine', version: '1.0.0', ref: 'legacy-clean-machine-lane', gating: false, authoritative: false });
  assert.equal(future.target.role, 'future-lane');
  assert.equal(future.target.gating, false);

  const release = observe({ version: '0.11.1', verify: true, candidate, futureLane }, overrides);
  assert.equal(release.target.role, 'candidate');
  assert.equal(release.target.gating, true);
  assert.deepEqual(release.lanes.future, future.lanes.future);
  assert.doesNotMatch(release.findings.join('\n'), /1\.0\.0/, 'legacy lane data cannot gate an ordinary candidate');
  assert.match(renderHuman(release), /Baseline: jarvos-bootstrap-v0\.11\.0; candidate: 0\.11\.1/);
  assert.match(renderHuman(release), /Future lane: clean-machine 1\.0\.0 \(non-gating\)/);
});

test('candidate lane reports explicit none and unavailable rather than inheriting drift or the future lane', () => {
  const none = observeV011({ candidate: { status: 'none' }, futureLane: { version: '1.0.0' } });
  assert.equal(none.lanes.candidate.status, 'none');
  assert.equal(none.lanes.candidate.version, null);

  const unavailable = observeV011({ candidate: { status: 'unavailable', source: 'release-please-pr' } });
  assert.deepEqual(unavailable.lanes.candidate, { status: 'unavailable', version: null, source: 'release-please-pr' });
});

test('a changelog-derived version equal to the future lane is never inferred as the candidate', () => {
  const futureLane = { kind: 'clean-machine', version: '1.0.0', ref: 'legacy-clean-machine-lane' };
  const checks = {
    drift: () => ({ state: 'ready-to-tag', drift: false, packageVersion: '1.0.0', candidateVersion: '1.0.0', messages: [] }),
    readiness: () => ({ ok: true, results: [] }),
  };

  for (const mode of [{ verify: true }, { reducedCost: true, verify: false }]) {
    const result = observeV011({ ...mode, futureLane }, { checks });
    assert.equal(result.lanes.baseline.version, '0.11.0');
    assert.deepEqual(result.lanes.candidate, { status: 'none', version: null, source: null });
    assert.equal(result.lanes.future.version, '1.0.0');
    assert.equal(result.lanes.future.status, 'future');
    assert.equal(JSON.stringify(result.lanes).includes('"v1.0.0"'), false, 'no candidate v1.0.0 is emitted');
    assert.equal(JSON.stringify(result.lanes).match(/"version":"1\.0\.0"/g).length, 1, 'the version appears in exactly one lane');
    assert.match(renderHuman(result), /Baseline: jarvos-bootstrap-v0\.11\.0; candidate: none/);
    assert.match(renderHuman(result), /Future lane: clean-machine 1\.0\.0 \(non-gating\)/);
  }

  const future = observe({ version: '1.0.0', verify: true, futureLane }, {
    github: { latestRelease: v011Published },
    checks,
  });
  assert.equal(future.target.role, 'future-lane');
  assert.equal(future.lanes.candidate.status, 'none');
  assert.equal(future.lanes.future.version, '1.0.0');
});

test('an explicit candidate that conflicts with the future lane is unavailable with a bounded finding', () => {
  const futureLane = { kind: 'clean-machine', version: '1.0.0' };
  const candidate = { status: 'present', version: '1.0.0', source: 'release-please-pr' };
  const checks = {
    drift: () => ({ state: 'ok', drift: false, packageVersion: '1.0.0', candidateVersion: '1.0.0', messages: [] }),
    readiness: () => ({ ok: true, results: [] }),
  };

  for (const mode of [{ verify: true }, { reducedCost: true, verify: false }]) {
    const result = observeV011({ ...mode, candidate, futureLane }, { checks });
    assert.deepEqual(result.lanes.candidate, { status: 'unavailable', version: null, source: 'release-please-pr' });
    assert.equal(result.lanes.future.version, '1.0.0');
    assert.equal(JSON.stringify(result.lanes).includes('"v1.0.0"'), false);
    assert.equal(JSON.stringify(result.lanes).match(/"version":"1\.0\.0"/g).length, 1);
    assert.deepEqual(result.findings, ['candidate 1.0.0 conflicts with the configured future lane; candidate lane is unavailable']);
  }

  const distinct = observeV011({ candidate: { status: 'present', version: '0.11.1', source: 'release-please-pr' }, futureLane }, { checks });
  assert.deepEqual(distinct.lanes.candidate, { status: 'present', version: '0.11.1', source: 'release-please-pr' });
  assert.deepEqual(distinct.findings, []);
});

test('a future lane equal to the published baseline is retired without a candidate or a blocker', () => {
  const tag = 'jarvos-bootstrap-v1.0.0';
  const futureLane = { kind: 'clean-machine', version: '1.0.0', ref: 'legacy-clean-machine-lane' };
  const overrides = {
    git: { tagForSha: (_sha, name) => name === tag ? name : null },
    github: { latestRelease: () => ({ tagName: tag, publishedAt: '2026-09-19T00:00:00.000Z' }) },
    checks: {
      drift: () => ({ state: 'ready-to-tag', drift: false, packageVersion: '1.0.0', candidateVersion: '1.0.0', messages: [] }),
      readiness: () => ({ ok: true, results: [] }),
    },
  };

  const sameVersionCandidate = { status: 'present', version: '1.0.0', source: 'release-please-pr' };
  for (const candidate of [undefined, sameVersionCandidate]) {
    for (const mode of [{ verify: true }, { reducedCost: true, verify: false }]) {
      const result = observe({ version: '1.0.0', sourceRef: tag, candidate, futureLane, ...mode }, overrides);
      assert.deepEqual(result.lanes.baseline, { status: 'published', version: '1.0.0', tag, publishedAt: '2026-09-19T00:00:00.000Z' });
      assert.deepEqual(result.lanes.candidate, { status: 'none', version: null, source: null });
      assert.equal(result.lanes.future, null);
      assert.equal(result.target.role, 'published-baseline');
      assert.deepEqual(result.findings, [], 'the retired future lane is not a blocker');
      assert.equal(JSON.stringify(result.lanes).match(/"version":"1\.0\.0"/g).length, 1, 'the version appears in exactly one lane');
      assert.doesNotMatch(renderHuman(result), /Future lane/);
    }
  }
});

test('a drift-detected finalized candidate ahead of the baseline populates the candidate lane', () => {
  const result = observeV011({ version: '0.11.1', sourceRef: 'origin/main' }, {
    github: { latestRelease: v011Published },
    git: { tagForSha: () => null },
    checks: {
      drift: () => ({ state: 'ready-to-tag', drift: false, candidateVersion: '0.11.1', messages: [] }),
      readiness: () => ({ ok: true, results: [] }),
    },
  });
  assert.equal(result.lanes.candidate.status, 'present');
  assert.equal(result.lanes.candidate.version, '0.11.1');
  assert.equal(result.target.role, 'candidate');
});

test('a package-prefixed baseline with post-tag commits does not infer a candidate lane', () => {
  const driftInputs = [];
  const result = observeV011({ reducedCost: true, verify: false }, {
    checks: {
      drift: (input) => {
        driftInputs.push(input);
        return { state: 'unlogged-work', drift: true, candidateVersion: null, commitsSinceTag: 3, messages: ['3 commit(s) since tag'] };
      },
    },
  });

  assert.equal(result.lanes.baseline.tag, V011_TAG);
  assert.equal(result.lanes.candidate.status, 'none');
  assert.equal(result.lanes.candidate.version, null);
  assert.equal(driftInputs[0].candidate, undefined, 'no candidate observation is invented for the drift check');
  assert.match(result.findings.join('\n'), /release drift/);
});

test('an explicit candidate observation is forwarded to the drift check', () => {
  const candidate = { status: 'present', version: '0.11.1', source: 'release-please-pr' };
  const driftInputs = [];
  const drift = (input) => { driftInputs.push(input); return { state: 'ok', drift: false, messages: [] }; };
  observeV011({ reducedCost: true, verify: false, candidate }, { checks: { drift } });
  observeV011({ candidate }, { checks: { drift, readiness: () => ({ ok: true, results: [] }) } });

  assert.equal(driftInputs.length, 2);
  for (const input of driftInputs) assert.deepEqual(input.candidate, candidate);
});

test('local and GitHub publication disagreement remains an explicit finding', () => {
  const result = observe({ verify: true }, {
    git: { tagForSha: () => 'v1.0.0' },
    github: { releaseByTag: () => null },
  });

  assert.match(result.findings.join('\n'), /local tag v1\.0\.0 has no matching GitHub release/);
  assert.equal(result.publication.published, false);
});

test('a reduced-cost observation is partial and names the omitted full verification', () => {
  const result = observe({ reducedCost: true });

  assert.equal(result.availability, 'available');
  assert.equal(result.verification.coverage, 'partial');
  assert.deepEqual(result.omissions, ['full candidate verification (npm test) was skipped by reduced-cost mode']);
  assert.equal(result.readiness.status, 'not-evaluated');
  assert.match(renderHuman(result), /^PARTIAL v1\.0\.0/);
});

test('source-bound observation rejects a checkout whose HEAD differs from the requested ref', () => {
  const result = observe({ reducedCost: true }, { git: { headSha: () => 'b'.repeat(40) } });
  assert.equal(result.availability, 'unavailable');
  assert.equal(result.failure.code, 'CHECKOUT_MISMATCH');
});

test('source-bound observation rejects a local ref that disagrees with canonical GitHub identity', () => {
  const result = observe({ reducedCost: true }, { github: { sourceRefSha: () => 'b'.repeat(40) } });
  assert.equal(result.availability, 'unavailable');
  assert.equal(result.failure.code, 'UNTRUSTED_SOURCE');
});

test('source-bound observation rejects dirty checkouts before reading release facts', () => {
  let checksCalled = false;
  const result = observe({ verify: true }, {
    git: { isClean: () => false },
    checks: { readiness: () => { checksCalled = true; return { ok: true, results: [] }; } },
  });
  assert.equal(result.availability, 'unavailable');
  assert.equal(result.failure.code, 'CHECKOUT_DIRTY');
  assert.equal(checksCalled, false);
});

test('verified observation rejects an unattested dependency tree before running tests', () => {
  let checksCalled = false;
  const result = observe({ verify: true }, {
    git: { prepareVerification: () => null },
    checks: { readiness: () => { checksCalled = true; return { ok: true, results: [] }; } },
  });
  assert.equal(result.availability, 'unavailable');
  assert.equal(result.failure.code, 'DEPENDENCY_UNAVAILABLE');
  assert.equal(checksCalled, false);
});

test('verified mode passes strict readiness options and redacts untrusted check details', () => {
  let readinessOptions;
  const result = observe({ verify: true }, {
    checks: {
      readiness: (options) => {
        readinessOptions = options;
        return { ok: false, results: [{ ok: false, label: 'smoke test', detail: 'SECRET=do-not-leak /private/fixture' }] };
      },
    },
  });
  assert.equal(readinessOptions.allowDirty, false);
  assert.equal(readinessOptions.allowUnreleased, false);
  assert.doesNotMatch(JSON.stringify(result), /do-not-leak|\/private\/fixture/);
});

test('publication disagreement prevents a verified READY result', () => {
  const result = observe({ verify: true }, {
    git: { tagForSha: () => null },
    github: { releaseByTag: () => ({ tagName: 'v1.0.0', publishedAt: '2026-08-13T00:00:00.000Z' }) },
    checks: { readiness: () => ({ ok: true, results: [] }) },
  });
  assert.equal(result.readiness.status, 'not-ready');
  assert.match(result.findings.join('\n'), /observed commit is not tagged v1\.0\.0/);
});

test('untrusted source provenance is unavailable and does not run source-controlled checks', () => {
  let checksCalled = false;
  const result = observe({ verify: true }, {
    git: { isReachableFrom: () => false },
    checks: { readiness: () => { checksCalled = true; return { ok: true, results: [] }; } },
  });

  assert.equal(result.availability, 'unavailable');
  assert.equal(result.failure.code, 'UNTRUSTED_SOURCE');
  assert.equal(checksCalled, false);
});

test('adapter failures are unavailable without leaking absolute paths', () => {
  const result = observe({ verify: true }, {
    github: { latestRelease: () => { throw new Error('failed at /private/secret/path'); } },
  });

  assert.equal(result.availability, 'unavailable');
  assert.equal(result.failure.code, 'GITHUB_UNAVAILABLE');
  assert.doesNotMatch(JSON.stringify(result), /\/private\/secret\/path/);
});

test('GitHub requests reject on the bounded timeout', async () => {
  const request = new EventEmitter();
  request.setTimeout = (milliseconds, callback) => {
    assert.equal(milliseconds, 15_000);
    callback();
  };
  request.destroy = (error) => process.nextTick(() => request.emit('error', error));
  await assert.rejects(githubRequest('/repos/levineam/jarvOS/releases/latest', () => request), /timed out/);
});

test('GitHub responses reject before an oversized body can accumulate', async () => {
  const request = new EventEmitter();
  request.setTimeout = () => {};
  request.destroy = (error) => process.nextTick(() => request.emit('error', error));
  const response = new EventEmitter();
  response.statusCode = 200;
  response.headers = { 'content-length': String(1_000_001) };
  response.setEncoding = () => {};
  response.destroy = (error) => process.nextTick(() => response.emit('error', error));
  await assert.rejects(githubRequest('/repos/levineam/jarvOS/releases/latest', (_options, callback) => {
    process.nextTick(() => callback(response));
    return request;
  }), /bounded size limit/);
});

test('human rendering is derived deterministically from normalized JSON', () => {
  const result = observe({ verify: true });
  assert.equal(renderHuman(result), renderHuman(JSON.parse(JSON.stringify(result))));
  assert.match(renderHuman(result), /NOT READY v1\.0\.0/);
});

test('CLI arguments require version, source policy, and one explicit verification mode', () => {
  assert.throws(() => parseArgs(['--version', 'v1.0.0']), /--source-ref is required/);
  assert.throws(() => parseArgs(['--version', 'v1.0.0', '--source-ref', 'origin/main']), /--verify or --reduced-cost is required/);
  assert.deepEqual(parseArgs(['--version', 'v1.0.0', '--source-ref', 'origin/main', '--verify', '--json']), {
    version: '1.0.0', sourceRef: 'origin/main', verify: true, reducedCost: false, json: true,
  });
});

test('CLI production checks preserve the isolated verification context', () => {
  const checks = createProductionChecks();
  const readiness = checks.readiness({
    version: '1.0.0',
    root: process.cwd(),
    env: { PATH: process.env.PATH, HOME: process.env.HOME, CI: '1' },
    npmPath: process.platform === 'win32' ? 'cmd.exe' : '/bin/false',
    allowDirty: false,
    allowUnreleased: false,
  });
  const smoke = readiness.results.find((check) => check.label === 'smoke test');
  assert.ok(smoke);
  assert.equal(smoke.ok, false);
  assert.notEqual(smoke.detail, 'npm test passed');
  const drift = checks.drift({ root: process.cwd(), env: { PATH: process.env.PATH, HOME: process.env.HOME, CI: '1' } });
  assert.equal(typeof drift.state, 'string');
});
