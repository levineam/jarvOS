'use strict';

const { execFile } = require('child_process');

const LOOP_STAGES = Object.freeze([
  'claim',
  'branch',
  'sliceReview',
  'holisticReview',
  'fixAndRerun',
  'pullRequest',
  'postMergeSweep',
  'verify',
  'closeIssue',
]);

const DEFAULT_BLOCKING_SEVERITIES = Object.freeze(['blocker', 'critical', 'high', 'error']);

const DEFAULT_REVIEW_COMMANDS = Object.freeze({
  sliceReview: Object.freeze({
    command: 'clawpatch',
    args: Object.freeze(['review', '--json']),
  }),
  holisticReview: Object.freeze({
    command: 'autoreview',
    args: Object.freeze(['--json']),
  }),
});

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function nowIso(clock) {
  if (clock && typeof clock.now === 'function') return new Date(clock.now()).toISOString();
  return new Date().toISOString();
}

function execFileRunner(command, args, options = {}) {
  return new Promise((resolve) => {
    execFile(command, args, {
      cwd: options.cwd,
      env: options.env,
      timeout: options.timeoutMs,
      maxBuffer: options.maxBuffer || 1024 * 1024 * 10,
    }, (error, stdout, stderr) => {
      resolve({
        ok: !error,
        exitCode: error && typeof error.code === 'number' ? error.code : 0,
        signal: error && error.signal ? error.signal : null,
        stdout: stdout || '',
        stderr: stderr || '',
        error: error ? error.message : null,
      });
    });
  });
}

function parseMaybeJson(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch (_) {
    return null;
  }
}

function normalizeFindings(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  if (Array.isArray(value.findings)) return value.findings;
  if (Array.isArray(value.issues)) return value.issues;
  return [];
}

function findingSeverity(finding) {
  if (!isObject(finding)) return '';
  return String(finding.severity || finding.level || finding.type || '').toLowerCase();
}

function normalizeReviewResult(result, fallback = {}) {
  const parsed = parseMaybeJson(result && result.stdout);
  const source = isObject(parsed) ? parsed : (isObject(result) ? result : {});
  const findings = normalizeFindings(source);
  const ok = result && result.ok === false
    ? false
    : typeof source.ok === 'boolean'
      ? source.ok
      : typeof source.passed === 'boolean'
        ? source.passed
        : result && typeof result.ok === 'boolean'
          ? result.ok
          : true;

  return {
    ok,
    stage: fallback.stage,
    summary: source.summary || source.message || fallback.summary || '',
    findings,
    evidence: source.evidence || source.artifacts || {},
    raw: {
      exitCode: result && Number.isInteger(result.exitCode) ? result.exitCode : 0,
      stdout: result && result.stdout ? result.stdout : '',
      stderr: result && result.stderr ? result.stderr : '',
      error: result && result.error ? result.error : null,
    },
  };
}

function blockingFindings(reviewResult, options = {}) {
  const severities = new Set(options.blockingSeverities || DEFAULT_BLOCKING_SEVERITIES);
  const findings = normalizeFindings(reviewResult);
  if (reviewResult && reviewResult.ok === false && findings.length === 0) {
    return [{ severity: 'error', message: reviewResult.summary || 'review failed' }];
  }
  return findings.filter((finding) => {
    if (finding && finding.blocking === false) return false;
    if (finding && finding.blocking === true) return true;
    return severities.has(findingSeverity(finding));
  });
}

function reviewPassed(reviewResult, options = {}) {
  return Boolean(reviewResult && reviewResult.ok !== false && blockingFindings(reviewResult, options).length === 0);
}

function mergeReviewCommand(base, override) {
  const command = override || base;
  if (typeof command === 'string') return { command, args: [] };
  if (!isObject(command) || !command.command) {
    throw new Error('review command must be a string or { command, args } object');
  }
  return {
    command: command.command,
    args: Array.isArray(command.args) ? command.args.slice() : [],
    env: command.env,
    cwd: command.cwd,
    timeoutMs: command.timeoutMs,
  };
}

function buildReviewArgs(baseArgs, request) {
  const args = baseArgs.slice();
  if (request.issueId) args.push('--issue', request.issueId);
  if (request.branchName) args.push('--branch', request.branchName);
  if (request.definitionOfDone) args.push('--definition-of-done', request.definitionOfDone);
  if (request.auditPath) args.push('--audit', request.auditPath);
  return args;
}

function createCommandReviewEngine(options = {}) {
  const runner = options.runner || execFileRunner;
  const commands = {
    sliceReview: mergeReviewCommand(DEFAULT_REVIEW_COMMANDS.sliceReview, options.sliceReviewCommand),
    holisticReview: mergeReviewCommand(DEFAULT_REVIEW_COMMANDS.holisticReview, options.holisticReviewCommand),
  };

  async function runReview(stage, request = {}) {
    const configured = commands[stage];
    const args = buildReviewArgs(configured.args, request);
    const result = await runner(configured.command, args, {
      cwd: request.cwd || configured.cwd || options.cwd,
      env: Object.assign({}, process.env, options.env || {}, configured.env || {}, request.env || {}),
      timeoutMs: request.timeoutMs || configured.timeoutMs || options.timeoutMs,
    });
    return normalizeReviewResult(result, {
      stage,
      summary: `${configured.command} ${args.join(' ')}`.trim(),
    });
  }

  return {
    kind: 'command-review-engine',
    commands,
    sliceReview(request) {
      return runReview('sliceReview', request);
    },
    holisticReview(request) {
      return runReview('holisticReview', request);
    },
  };
}

function createDefaultReviewEngine(options = {}) {
  return createCommandReviewEngine(options);
}

function assertMethod(owner, method, stage) {
  if (!owner || typeof owner[method] !== 'function') {
    throw new Error(`stage ${stage} requires ${method}()`);
  }
}

function createMemoryAuditSink(clock) {
  const events = [];
  return {
    events,
    async record(event) {
      events.push(Object.assign({ timestamp: nowIso(clock) }, event));
      return event;
    },
  };
}

function createCodingOrchestrator(options = {}) {
  const reviewEngine = options.reviewEngine || createDefaultReviewEngine(options.reviewEngineOptions || {});
  assertMethod(reviewEngine, 'sliceReview', 'sliceReview');
  assertMethod(reviewEngine, 'holisticReview', 'holisticReview');

  const clock = options.clock;
  const auditSink = options.auditSink || createMemoryAuditSink(clock);
  const blockingOptions = {
    blockingSeverities: options.blockingSeverities || DEFAULT_BLOCKING_SEVERITIES,
  };

  async function record(event) {
    if (auditSink && typeof auditSink.record === 'function') {
      await auditSink.record(Object.assign({ timestamp: nowIso(clock) }, event));
    }
  }

  async function stage(name, fn, details = {}) {
    await record({ type: 'stage.started', stage: name, details });
    try {
      const output = await fn();
      await record({ type: 'stage.completed', stage: name, output: summarizeOutput(output) });
      return output;
    } catch (error) {
      await record({ type: 'stage.failed', stage: name, error: error.message });
      throw error;
    }
  }

  function auditTrail() {
    if (Array.isArray(auditSink.events)) return auditSink.events.slice();
    return [];
  }

  async function runTakeIssueToDone(request = {}) {
    if (!request.issueId) throw new Error('issueId is required');
    const maxFixCycles = Number.isInteger(request.maxFixCycles) ? request.maxFixCycles : 1;
    const definitionOfDone = request.definitionOfDone || '';
    const context = request.context || {};

    assertMethod(options.issueDriver, 'claim', 'claim');
    assertMethod(options.branchDriver, 'createBranch', 'branch');
    assertMethod(options.pullRequestDriver, 'open', 'pullRequest');
    assertMethod(options.postMergeDriver, 'sweep', 'postMergeSweep');
    assertMethod(options.verificationDriver, 'verify', 'verify');
    assertMethod(options.issueDriver, 'close', 'closeIssue');

    const state = {
      issueId: request.issueId,
      definitionOfDone,
      context,
      reviewCycles: [],
    };

    state.issue = await stage('claim', () => options.issueDriver.claim({
      issueId: request.issueId,
      context,
    }), { issueId: request.issueId });

    state.branch = await stage('branch', () => options.branchDriver.createBranch({
      issueId: request.issueId,
      issue: state.issue,
      branchName: request.branchName,
      context,
    }), { issueId: request.issueId, branchName: request.branchName });

    const branchName = state.branch && (state.branch.name || state.branch.branchName) || request.branchName;

    for (let iteration = 0; iteration <= maxFixCycles; iteration += 1) {
      const reviewRequest = {
        issueId: request.issueId,
        issue: state.issue,
        branch: state.branch,
        branchName,
        iteration,
        definitionOfDone,
        context,
        cwd: request.cwd,
        auditTrail: auditTrail(),
      };

      const sliceReview = await stage('sliceReview', () => reviewEngine.sliceReview(reviewRequest), { iteration });
      const holisticReview = await stage('holisticReview', () => reviewEngine.holisticReview(Object.assign({}, reviewRequest, {
        sliceReview,
        auditTrail: auditTrail(),
      })), { iteration });

      const cycleBlockingFindings = [
        ...blockingFindings(sliceReview, blockingOptions),
        ...blockingFindings(holisticReview, blockingOptions),
      ];
      const cycle = {
        iteration,
        sliceReview,
        holisticReview,
        blockingFindings: cycleBlockingFindings,
        passed: reviewPassed(sliceReview, blockingOptions) && reviewPassed(holisticReview, blockingOptions),
      };
      state.reviewCycles.push(cycle);

      if (cycle.passed) break;
      if (iteration >= maxFixCycles) {
        throw new Error(`reviews still block after ${maxFixCycles} fix cycle(s)`);
      }

      assertMethod(options.fixDriver, 'fixAndRerun', 'fixAndRerun');
      state.lastFix = await stage('fixAndRerun', () => options.fixDriver.fixAndRerun({
        issueId: request.issueId,
        issue: state.issue,
        branch: state.branch,
        branchName,
        iteration,
        sliceReview,
        holisticReview,
        blockingFindings: cycleBlockingFindings,
        definitionOfDone,
        context,
      }), { iteration, blockingFindings: cycleBlockingFindings.length });
    }

    state.pullRequest = await stage('pullRequest', () => options.pullRequestDriver.open({
      issueId: request.issueId,
      issue: state.issue,
      branch: state.branch,
      branchName,
      reviewCycles: state.reviewCycles,
      definitionOfDone,
      context,
    }), { branchName });

    if (typeof options.pullRequestDriver.waitForMerge === 'function') {
      state.merge = await stage('waitForMerge', () => options.pullRequestDriver.waitForMerge({
        issueId: request.issueId,
        pullRequest: state.pullRequest,
        context,
      }), { pullRequest: state.pullRequest && state.pullRequest.url });
    }

    state.postMergeSweep = await stage('postMergeSweep', () => options.postMergeDriver.sweep({
      issueId: request.issueId,
      issue: state.issue,
      branch: state.branch,
      pullRequest: state.pullRequest,
      merge: state.merge,
      context,
    }), { pullRequest: state.pullRequest && state.pullRequest.url });

    state.verification = await stage('verify', () => options.verificationDriver.verify({
      issueId: request.issueId,
      issue: state.issue,
      branch: state.branch,
      pullRequest: state.pullRequest,
      postMergeSweep: state.postMergeSweep,
      definitionOfDone,
      context,
    }), { issueId: request.issueId });

    if (state.verification && state.verification.ok === false) {
      throw new Error(state.verification.summary || 'verification failed');
    }

    state.closedIssue = await stage('closeIssue', () => options.issueDriver.close({
      issueId: request.issueId,
      issue: state.issue,
      branch: state.branch,
      pullRequest: state.pullRequest,
      verification: state.verification,
      auditTrail: auditTrail(),
      context,
    }), { issueId: request.issueId });

    return {
      ok: true,
      issueId: request.issueId,
      branch: state.branch,
      pullRequest: state.pullRequest,
      postMergeSweep: state.postMergeSweep,
      verification: state.verification,
      closedIssue: state.closedIssue,
      reviewCycles: state.reviewCycles,
      auditTrail: auditTrail(),
    };
  }

  return {
    stages: LOOP_STAGES.slice(),
    reviewEngine,
    runTakeIssueToDone,
  };
}

function summarizeOutput(output) {
  if (!isObject(output)) return output;
  const summary = {};
  for (const key of ['id', 'identifier', 'name', 'branchName', 'url', 'ok', 'summary', 'status']) {
    if (Object.prototype.hasOwnProperty.call(output, key)) summary[key] = output[key];
  }
  if (Array.isArray(output.findings)) summary.findingCount = output.findings.length;
  return Object.keys(summary).length > 0 ? summary : { type: output.constructor && output.constructor.name || 'Object' };
}

module.exports = {
  DEFAULT_BLOCKING_SEVERITIES,
  DEFAULT_REVIEW_COMMANDS,
  LOOP_STAGES,
  blockingFindings,
  createCodingOrchestrator,
  createCommandReviewEngine,
  createDefaultReviewEngine,
  createMemoryAuditSink,
  execFileRunner,
  normalizeReviewResult,
  reviewPassed,
};
