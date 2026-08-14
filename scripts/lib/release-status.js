#!/usr/bin/env node
'use strict';

const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const { checkReleaseReadiness, normalizeVersion } = require('../release-readiness-check');
const { checkUnreleasedDrift, semverTags } = require('../unreleased-drift-check');

const CONTRACT = 'jarvos.release-observation/v1';
const REPOSITORY = 'levineam/jarvOS';
const PROTECTED_BRANCH = 'origin/main';
const SHA = /^[0-9a-f]{40}$/i;
const GITHUB_TIMEOUT_MS = 15_000;
const GITHUB_MAX_RESPONSE_BYTES = 1_000_000;
const NPM_INSTALL_TIMEOUT_MS = 60_000;

function verificationEnvironment() {
  const nodeBin = path.dirname(process.execPath);
  return {
    PATH: [nodeBin, '/usr/local/bin', '/opt/homebrew/bin', '/usr/bin', '/bin'].join(path.delimiter),
    HOME: os.homedir(),
    TMPDIR: os.tmpdir(),
    LANG: 'C',
    LC_ALL: 'C',
    CI: '1',
    NODE_ENV: 'test',
  };
}

function npmExecutable() {
  const candidates = process.platform === 'win32'
    ? [path.join(path.dirname(process.execPath), 'npm.cmd')]
    : [path.join(path.dirname(process.execPath), 'npm'), '/usr/local/bin/npm', '/opt/homebrew/bin/npm', '/usr/bin/npm'];
  const candidate = candidates.find((value) => fs.existsSync(value));
  if (candidate) return fs.realpathSync(candidate);
  throw new Error('trusted npm executable is unavailable');
}

function safeDetail(error) {
  const detail = String(error && error.message ? error.message : error || 'unknown error')
    .replace(/(?:[A-Za-z]:)?\/[\w./-]+/g, '<redacted-path>')
    .replace(/\s+/g, ' ')
    .trim();
  return detail.slice(0, 240) || 'unknown error';
}

function safeCheckDetail(value) {
  return safeDetail(String(value || ''))
    .replace(/\b(?:TOKEN|SECRET|PASSWORD|PASS|KEY|CREDENTIAL|AUTH|[A-Z][A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASS|KEY|CREDENTIAL|AUTH)[A-Z0-9_]*)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;}]+)/gi, '<redacted-secret>')
    .replace(/(["']?)(?:token|secret|password|passwd|api[_-]?key|authorization|cookie)\1\s*:\s*(?:"[^"]*"|'[^']*'|[^,}\s]+)/gi, '$1$2$1:<redacted>')
    .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer <redacted>');
}

function normalizeReadiness(readiness) {
  return {
    ok: Boolean(readiness && readiness.ok),
    results: Array.isArray(readiness && readiness.results)
      ? readiness.results.map((check) => ({
        ok: Boolean(check && check.ok),
        label: safeCheckDetail(check && check.label),
        detail: /(?:smoke|npm test|verification)/i.test(String(check && check.label || ''))
          ? (check && check.ok ? 'verification passed' : 'verification failed; inspect the isolated verification run')
          : safeCheckDetail(check && check.detail),
      }))
      : [],
  };
}

function normalizeDrift(drift) {
  const optionalString = (value) => value == null ? null : safeCheckDetail(value);
  return {
    packageVersion: optionalString(drift && drift.packageVersion),
    latestTag: optionalString(drift && drift.latestTag),
    commitsSinceTag: Number.isInteger(drift && drift.commitsSinceTag) ? drift.commitsSinceTag : null,
    changelogHasVersionSection: Boolean(drift && drift.changelogHasVersionSection),
    changelogVersionDated: Boolean(drift && drift.changelogVersionDated),
    hasUnreleasedSection: Boolean(drift && drift.hasUnreleasedSection),
    unreleasedNonEmpty: Boolean(drift && drift.unreleasedNonEmpty),
    state: optionalString(drift && drift.state),
    drift: Boolean(drift && drift.drift),
    messages: Array.isArray(drift && drift.messages) ? drift.messages.map(safeCheckDetail).slice(0, 20) : [],
  };
}

function unavailable({ version, sourceRef, repository, observedAt, code, error }) {
  return {
    contract: CONTRACT,
    availability: 'unavailable',
    observedAt,
    source: { repository, requestedRef: sourceRef, resolvedSha: null, policy: null },
    target: { version, tag: `v${version}` },
    publication: null,
    drift: null,
    readiness: null,
    verification: { coverage: 'none' },
    findings: [],
    omissions: [],
    evidenceRefs: [],
    failure: { code, detail: safeDetail(error) },
  };
}

function assertSourcePolicy({ sourceRef, version, protectedBranch = PROTECTED_BRANCH }) {
  const approvedTag = `v${version}`;
  if (sourceRef !== protectedBranch && sourceRef !== approvedTag) {
    throw Object.assign(new Error(`source ref must be ${protectedBranch} or approved tag ${approvedTag}`), { code: 'SOURCE_POLICY_REJECTED' });
  }
}

function normalizeRelease(release) {
  if (!release) return null;
  const tagName = String(release.tagName || release.tag_name || '');
  if (!/^v\d+\.\d+\.\d+$/.test(tagName)) throw new Error('GitHub release response has no valid semver tag');
  return { tag: tagName, publishedAt: release.publishedAt || release.published_at || null };
}

function findingsFrom(readiness, drift, localTag, githubTargetRelease, targetTag) {
  const findings = [];
  for (const check of readiness && readiness.results || []) {
    if (!check.ok) findings.push(`${check.label}${check.detail ? `: ${check.detail}` : ''}`);
  }
  if (drift && drift.drift) findings.push(`release drift: ${(drift.messages || []).join(' ')}`.trim());
  if (localTag === targetTag && !githubTargetRelease) findings.push(`local tag ${targetTag} has no matching GitHub release`);
  if (githubTargetRelease && localTag !== targetTag) findings.push(`GitHub release ${targetTag} is published but the observed commit is not tagged ${targetTag}`);
  return findings;
}

function observeReleaseStatus(options) {
  const version = normalizeVersion(options.version);
  const sourceRef = String(options.sourceRef || '');
  const repository = options.repository || REPOSITORY;
  const observedAt = (options.now || (() => new Date().toISOString()))();
  const protectedBranch = options.protectedBranch || PROTECTED_BRANCH;
  const targetTag = `v${version}`;
  let verificationContext = null;
  const cleanupVerification = () => {
    if (!verificationContext) return;
    try { verificationContext.cleanup(); } finally { verificationContext = null; }
  };

  if (!/^\d+\.\d+\.\d+$/.test(version)) return unavailable({ version, sourceRef, repository, observedAt, code: 'INVALID_TARGET', error: 'target version must be semver' });
  try {
    if (repository !== REPOSITORY) throw Object.assign(new Error('repository must be the configured jarvOS upstream'), { code: 'FOREIGN_REPOSITORY' });
    assertSourcePolicy({ sourceRef, version, protectedBranch });
    const resolved = options.git.resolveRef(sourceRef);
    const resolvedSha = typeof resolved === 'string' ? resolved : resolved && resolved.sha;
    if (!SHA.test(resolvedSha || '')) throw Object.assign(new Error('source ref did not resolve to an immutable commit SHA'), { code: 'AMBIGUOUS_SOURCE' });
    if (!options.git.isReachableFrom(resolvedSha, protectedBranch) && sourceRef !== targetTag) {
      throw Object.assign(new Error('resolved SHA is not reachable from the configured protected branch'), { code: 'UNTRUSTED_SOURCE' });
    }
    if (sourceRef === targetTag && options.git.tagForSha(resolvedSha, targetTag) !== targetTag) {
      throw Object.assign(new Error('approved release tag does not point at the resolved SHA'), { code: 'UNTRUSTED_SOURCE' });
    }
    if (typeof options.github.sourceRefSha !== 'function') {
      throw Object.assign(new Error('canonical GitHub source identity is unavailable'), { code: 'SOURCE_IDENTITY_UNAVAILABLE' });
    }
    if (typeof options.git.headSha !== 'function' || options.git.headSha() !== resolvedSha) {
      throw Object.assign(new Error('verification checkout does not match the resolved source SHA'), { code: 'CHECKOUT_MISMATCH' });
    }
    if (typeof options.git.isClean !== 'function' || !options.git.isClean()) {
      throw Object.assign(new Error('verification checkout has uncommitted or untracked changes'), { code: 'CHECKOUT_DIRTY' });
    }

    let latestRelease;
    let githubTargetRelease;
    let canonicalSha;
    try {
      const canonicalRef = sourceRef === protectedBranch ? protectedBranch.replace(/^origin\//, '') : targetTag;
      canonicalSha = options.github.sourceRefSha(repository, canonicalRef);
      latestRelease = normalizeRelease(options.github.latestRelease(repository));
      githubTargetRelease = normalizeRelease(options.github.releaseByTag(repository, targetTag));
    } catch (error) {
      return unavailable({ version, sourceRef, repository, observedAt, code: 'GITHUB_UNAVAILABLE', error });
    }
    if (!SHA.test(canonicalSha || '') || canonicalSha !== resolvedSha) {
      throw Object.assign(new Error('resolved SHA does not match the canonical GitHub source ref'), { code: 'UNTRUSTED_SOURCE' });
    }

    if (options.verify) {
      try {
        verificationContext = options.git.prepareVerification(resolvedSha);
        if (!verificationContext || typeof verificationContext.cleanup !== 'function') throw new Error('verification checkout could not be prepared');
      } catch (error) {
        cleanupVerification();
        return unavailable({ version, sourceRef, repository, observedAt, code: 'DEPENDENCY_UNAVAILABLE', error });
      }
    }

    const localTag = options.git.tagForSha(resolvedSha, targetTag);
    const commitDistance = options.git.commitDistance ? options.git.commitDistance(resolvedSha) : null;
    const policy = { protectedBranch, approvedReleaseTag: targetTag };
    if (!options.verify) {
      let drift;
      try {
        const rawDrift = options.checks.drift();
        if (!rawDrift || typeof rawDrift.state !== 'string') throw new Error('malformed drift check output');
        drift = normalizeDrift(rawDrift);
      } catch (error) {
        return unavailable({ version, sourceRef, repository, observedAt, code: 'CHECKS_UNAVAILABLE', error });
      }
      return {
        contract: CONTRACT, availability: 'available', observedAt,
        source: { repository, requestedRef: sourceRef, resolvedSha, commitDistance, policy },
        target: { version, tag: targetTag },
        publication: { published: Boolean(githubTargetRelease), latestPublicVersion: latestRelease ? latestRelease.tag.slice(1) : null, latestRelease, targetRelease: githubTargetRelease, localTag: localTag || null },
        drift,
        readiness: { status: 'not-evaluated', checks: [] },
        verification: { coverage: 'partial' },
        findings: findingsFrom(null, drift, localTag, githubTargetRelease, targetTag),
        omissions: ['full candidate verification (npm test) was skipped by reduced-cost mode'],
        evidenceRefs: [`git:${resolvedSha}`, `github:releases/${latestRelease ? latestRelease.tag : 'none'}`],
      };
    }

    let readiness;
    let drift;
    try {
      const checkOptions = {
        version,
        verify: true,
        allowDirty: false,
        allowUnreleased: false,
        root: verificationContext && verificationContext.root,
        env: verificationContext && verificationContext.env,
        npmPath: verificationContext && verificationContext.npmPath,
      };
      const rawReadiness = options.checks.readiness(checkOptions);
      const rawDrift = options.checks.drift(checkOptions);
      if (!rawReadiness || !Array.isArray(rawReadiness.results) || !rawDrift || typeof rawDrift.state !== 'string') {
        throw new Error('malformed release check output');
      }
      readiness = normalizeReadiness(rawReadiness);
      drift = normalizeDrift(rawDrift);
    } catch (error) {
      cleanupVerification();
      return unavailable({ version, sourceRef, repository, observedAt, code: 'CHECKS_UNAVAILABLE', error });
    }
    cleanupVerification();
    const findings = findingsFrom(readiness, drift, localTag, githubTargetRelease, targetTag);
    return {
      contract: CONTRACT, availability: 'available', observedAt,
      source: { repository, requestedRef: sourceRef, resolvedSha, commitDistance, policy },
      target: { version, tag: targetTag },
      publication: { published: Boolean(githubTargetRelease), latestPublicVersion: latestRelease ? latestRelease.tag.slice(1) : null, latestRelease, targetRelease: githubTargetRelease, localTag: localTag || null },
      drift,
      readiness: { status: readiness.ok && findings.length === 0 ? 'ready' : 'not-ready', checks: readiness.results },
      verification: { coverage: 'verified' },
      findings,
      omissions: [],
      evidenceRefs: [`git:${resolvedSha}`, `github:releases/${latestRelease ? latestRelease.tag : 'none'}`, 'release-readiness-check', 'unreleased-drift-check'],
    };
  } catch (error) {
    cleanupVerification();
    return unavailable({ version, sourceRef, repository, observedAt, code: error.code || 'SOURCE_UNAVAILABLE', error });
  }
}

function renderHuman(result) {
  const prefix = result.availability === 'unavailable'
    ? 'UNAVAILABLE'
    : result.readiness.status === 'ready'
      ? 'READY'
      : result.readiness.status === 'not-evaluated'
        ? 'PARTIAL'
        : 'NOT READY';
  const lines = [`${prefix} ${result.target.tag}`, `Coverage: ${result.verification.coverage}`];
  if (result.availability === 'unavailable') lines.push(`Reason: ${result.failure.code} — ${result.failure.detail}`);
  else {
    lines.push(`Source: ${result.source.requestedRef} @ ${result.source.resolvedSha}`);
    lines.push(`Published: ${result.publication.published}; latest public: ${result.publication.latestPublicVersion || 'none'}`);
    for (const finding of result.findings) lines.push(`Finding: ${finding}`);
    for (const omission of result.omissions) lines.push(`Omission: ${omission}`);
  }
  return lines.join('\n');
}

function runGit(args) { return execFileSync('git', args, { encoding: 'utf8' }).trim(); }
function latestSemverTag() { return semverTags().pop() || null; }
function gitAdapter() {
  return {
    resolveRef: (ref) => ({ ref, sha: runGit(['rev-parse', `${ref}^{commit}`]) }),
    isReachableFrom: (sha, branch) => { try { execFileSync('git', ['merge-base', '--is-ancestor', sha, branch]); return true; } catch (_) { return false; } },
    tagForSha: (sha, tag) => runGit(['tag', '--points-at', sha]).split(/\r?\n/).includes(tag) ? tag : null,
    headSha: () => runGit(['rev-parse', 'HEAD']),
    isClean: () => runGit(['status', '--porcelain']) === '',
    prepareVerification: (resolvedSha) => {
      const repositoryRoot = path.resolve(__dirname, '../..');
      const checkoutRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-release-status-'));
      const homeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-release-home-'));
      const env = { ...verificationEnvironment(), HOME: homeRoot };
      const cleanup = () => {
        try { execFileSync('git', ['worktree', 'remove', '--force', checkoutRoot], { cwd: repositoryRoot, env, stdio: 'ignore' }); } catch (_) { /* best effort */ }
        fs.rmSync(checkoutRoot, { recursive: true, force: true });
        fs.rmSync(homeRoot, { recursive: true, force: true });
      };
      try {
        execFileSync('git', ['worktree', 'add', '--detach', '--quiet', checkoutRoot, resolvedSha], { cwd: repositoryRoot, env, stdio: 'ignore' });
        const npmPath = npmExecutable();
        const result = spawnSync(npmPath, ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], {
          cwd: checkoutRoot,
          env,
          timeout: NPM_INSTALL_TIMEOUT_MS,
          killSignal: 'SIGTERM',
          stdio: 'ignore',
        });
        if (result.error && result.error.code === 'ETIMEDOUT') throw new Error('npm ci timed out in the isolated verification checkout');
        if (result.status !== 0) throw new Error('npm ci failed in the isolated verification checkout');
        return { root: checkoutRoot, env, npmPath, cleanup };
      } catch (error) {
        cleanup();
        throw error;
      }
    },
    commitDistance: (sha) => {
      const tag = latestSemverTag();
      return tag ? Number(runGit(['rev-list', '--count', `${tag}..${sha}`])) : null;
    },
  };
}

function githubRequest(path, requestFactory = https.get, requestOptions = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const totalTimeout = setTimeout(() => {
      request?.destroy?.(new Error('GitHub request timed out'));
    }, GITHUB_TIMEOUT_MS);
    totalTimeout.unref?.();
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(totalTimeout);
      callback(value);
    };
    let request;
    request = requestFactory({ hostname: 'api.github.com', path, headers: { 'User-Agent': 'jarvos-release-status', Accept: 'application/vnd.github+json' }, ...requestOptions }, (response) => {
      let body = '';
      let bodyBytes = 0;
      response.once?.('error', (error) => finish(reject, error));
      const rejectOversized = () => {
        const error = new Error('GitHub response exceeded the bounded size limit');
        response.destroy?.(error);
        request?.destroy?.(error);
        finish(reject, error);
      };
      const contentLength = Number(response.headers && response.headers['content-length']);
      if (Number.isFinite(contentLength) && contentLength > GITHUB_MAX_RESPONSE_BYTES) {
        rejectOversized();
        return;
      }
      response.setEncoding('utf8'); response.on('data', (chunk) => {
        bodyBytes += Buffer.byteLength(chunk);
        if (bodyBytes > GITHUB_MAX_RESPONSE_BYTES) {
          rejectOversized();
          return;
        }
        body += chunk;
      });
      response.on('end', () => {
        if (response.statusCode === 404) return finish(resolve, null);
        if (response.statusCode < 200 || response.statusCode >= 300) return finish(reject, new Error(`GitHub returned HTTP ${response.statusCode}`));
        try { finish(resolve, JSON.parse(body)); } catch (_) { finish(reject, new Error('GitHub returned malformed JSON')); }
      });
    });
    request.setTimeout(GITHUB_TIMEOUT_MS, () => {
      request.destroy(new Error('GitHub request timed out'));
    });
    request.on('error', (error) => finish(reject, error));
  });
}

// Injected adapters stay synchronous at the observation boundary. The production
// CLI calls these lazy requests together so independent GitHub reads overlap.
function productionGithub(repository, { signal } = {}) {
  const base = `/repos/${repository}/releases`;
  return {
    latestRelease: () => githubRequest(`${base}/latest`, https.get, { signal }),
    releaseByTag: (tag) => githubRequest(`${base}/tags/${encodeURIComponent(tag)}`, https.get, { signal }),
    sourceRefSha: (ref) => githubRequest(`/repos/${repository}/commits/${encodeURIComponent(ref)}`, https.get, { signal }).then((commit) => {
      return commit && commit.sha;
    }),
  };
}

function parseArgs(argv = process.argv.slice(2)) {
  const result = { version: '', sourceRef: '', verify: false, reducedCost: false, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--version' && argv[i + 1]) result.version = normalizeVersion(argv[++i]);
    else if (arg === '--source-ref' && argv[i + 1]) result.sourceRef = argv[++i];
    else if (arg === '--verify') result.verify = true;
    else if (arg === '--reduced-cost') result.reducedCost = true;
    else if (arg === '--json') result.json = true;
    else throw new Error(`unknown or incomplete argument: ${arg}`);
  }
  if (!result.version) throw new Error('--version is required');
  if (!result.sourceRef) throw new Error('--source-ref is required');
  if (result.verify === result.reducedCost) throw new Error('exactly one of --verify or --reduced-cost is required');
  return result;
}

module.exports = { CONTRACT, REPOSITORY, PROTECTED_BRANCH, observeReleaseStatus, parseArgs, renderHuman, gitAdapter, productionGithub, githubRequest };
