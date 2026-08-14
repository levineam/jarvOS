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
