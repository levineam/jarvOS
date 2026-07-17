'use strict';

const { assertReviewEngineAdapter } = require('../review-engine');
const {
  buildCodeThreadCheckpoint,
  readJarvosSessionState,
  writeJarvosSessionState,
} = require('../session-state');

const ORCHESTRATOR_SCHEMA_VERSION = 'jarvos-coding-orchestrator/v1';
const TAKE_ISSUE_TO_DONE_STAGES = Object.freeze([
  'claim',
  'branch',
  'sliceReview',
  'holisticReview',
  'fixRerun',
  'pullRequest',
  'postMergeSweep',
  'verifyClose',
]);

/** Final side-effect stages that must re-check the control-plane fence. */
const FENCED_MUTATION_STAGES = Object.freeze([
  'pullRequest',
  'postMergeSweep',
  'verifyClose',
]);

const SUCCESSFUL_CLOSE_STATUSES = new Set(['closed', 'verified', 'done', 'completed']);
const FAILED_STAGE_STATUSES = new Set(['failed', 'error', 'not_found']);
const DEFERRED_STAGE_STATUSES = new Set(['deferred', 'skipped', 'blocked', 'pending', 'incomplete']);

/**
 * Keys that may travel on a resume/checkpoint blob as reattachment hints.
 * These are never treated as proof of reviews, cleanliness, submission
 * readiness, merge, or issue close.
 */
const REATTACHMENT_HINT_KEYS = Object.freeze([
  'branch',
  'branchName',
  'pr',
  'prUrl',
  'pullRequestUrl',
  'pullRequest',
  'sessionId',
  'session',
  'worktree',
  'worktreePath',
  'artifact',
  'codeThread',
  'issueIdentifier',
]);

function requireFn(container, method, stage) {
  const fn = container?.[method];
  if (typeof fn !== 'function') {
    throw new Error(`orchestrator stage "${stage}" requires adapter method ${method}()`);
  }
  return fn.bind(container);
}

function stageNextStep(stage, index) {
  return TAKE_ISSUE_TO_DONE_STAGES[index + 1] || 'complete';
}

function buildStageEvent(stage, result, options = {}) {
  return {
    stage,
    status: result?.status || (result?.ok === false ? 'failed' : 'completed'),
    result: result || null,
    reattached: options.reattached === true,
  };
}

function firstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== '');
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Extract only reattachment hints from a resume/checkpoint/session blob.
 * Explicitly ignores nextStep/stage/phase/events as authority for progress.
 */
function extractReattachmentHints(source = null) {
  if (!isPlainObject(source)) return null;

  const codeThread = isPlainObject(source.codeThread) ? source.codeThread : null;
  const hints = {};

  for (const key of REATTACHMENT_HINT_KEYS) {
    if (source[key] !== undefined && source[key] !== null && source[key] !== '') {
      hints[key] = source[key];
    }
  }

  if (codeThread) {
    if (!hints.branch) {
      const nestedBranch = firstDefined(codeThread.branch, codeThread.branchName);
      if (nestedBranch) hints.branch = nestedBranch;
    }
    if (!hints.pr && !hints.prUrl && !hints.pullRequest) {
      const nestedPr = firstDefined(codeThread.pr, codeThread.prUrl, codeThread.pullRequest);
      if (nestedPr) {
        if (typeof nestedPr === 'string') hints.pr = nestedPr;
        else hints.pullRequest = nestedPr;
      }
    }
    if (!hints.issueIdentifier && codeThread.issueIdentifier) {
      hints.issueIdentifier = codeThread.issueIdentifier;
    }
    // Keep the thin code-thread pointer (branch/session metadata only). Do not
    // promote nextStep/stage as authoritative progress.
    hints.codeThread = {
      issueIdentifier: codeThread.issueIdentifier || null,
      branch: codeThread.branch || null,
      stage: codeThread.stage || null,
      lastDecision: codeThread.lastDecision || null,
      nextStep: codeThread.nextStep || null,
    };
  }

  const artifactKind = String(isPlainObject(hints.artifact) ? hints.artifact.kind || '' : '').toLowerCase();
  const artifactIsPullRequest = ['pull-request', 'pull_request', 'github-pr', 'review'].includes(artifactKind);
  const prUrl = firstDefined(
    hints.pr,
    hints.prUrl,
    hints.pullRequestUrl,
    isPlainObject(hints.pullRequest) ? hints.pullRequest.url : null,
    artifactIsPullRequest ? hints.artifact.url : null,
  );
  const pullRequestPointer = isPlainObject(hints.pullRequest)
    ? {
      // Pointer only — not merge/close proof.
      url: hints.pullRequest.url || prUrl || null,
      number: hints.pullRequest.number || null,
      reattached: true,
    }
    : (prUrl ? { url: prUrl, reattached: true } : null);

  const branch = firstDefined(
    hints.branch,
    hints.branchName,
    isPlainObject(hints.artifact) ? hints.artifact.branch : null,
  );

  if (!branch && !pullRequestPointer && !hints.sessionId && !hints.session && !hints.worktree && !hints.worktreePath && !hints.codeThread) {
    return null;
  }

  return {
    branch: branch || null,
    pullRequest: pullRequestPointer,
    sessionId: hints.sessionId || (isPlainObject(hints.session) ? hints.session.id || null : null),
    worktreePath: firstDefined(hints.worktreePath, hints.worktree) || null,
    issueIdentifier: hints.issueIdentifier || null,
    codeThread: hints.codeThread || null,
    artifact: hints.artifact || null,
    source: source,
  };
}

/**
 * Resolve resume pointers from explicit resumeFrom/checkpoint or session state.
 *
 * Safe contract: resume/checkpoint is only a reattachment hint (branch/PR/
 * session pointers). It is never proof of reviews, cleanliness, submission
 * readiness, merge, or issue close. Every stage still runs (or is
 * authoritatively revalidated) under the current fence at mutation boundaries.
 */
function resolveResumePlan(input = {}, entrySessionState = null) {
  const candidates = [
    input.resumeFrom,
    input.checkpoint,
    entrySessionState?.state,
    entrySessionState?.state?.codeThread ? entrySessionState.state : null,
  ].filter((value) => isPlainObject(value));

  let reattachment = null;
  for (const candidate of candidates) {
    const hints = extractReattachmentHints(candidate);
    if (hints) {
      reattachment = hints;
      break;
    }
  }

  const branch = firstDefined(
    input.branch,
    input.branchName,
    reattachment?.branch,
  );

  return {
    // Always re-run stages. Resume never advances the stage cursor.
    startIndex: 0,
    branch: branch || null,
    pullRequest: reattachment?.pullRequest || null,
    reattachment,
    // Intentionally empty: prior checkpoint events are not durable proof.
    priorResults: {},
    resume: reattachment?.source || null,
  };
}

function assertFenceForStage(stage, controlPlane) {
  if (!FENCED_MUTATION_STAGES.includes(stage)) return;
  if (!controlPlane || typeof controlPlane.assertCurrentFence !== 'function') return;
  controlPlane.assertCurrentFence();
}

function stageStatusToken(event) {
  return String(event?.result?.status || event?.status || '').toLowerCase();
}

function isFailedStageEvent(event) {
  if (!event) return false;
  if (event.result?.ok === false) return true;
  return FAILED_STAGE_STATUSES.has(stageStatusToken(event));
}

function deriveOrchestratorStatus(events) {
  for (const event of events) {
    if (isFailedStageEvent(event)) return 'failed';
  }

  const byStage = Object.fromEntries(events.map((event) => [event.stage, event]));
  const verify = byStage.verifyClose;
  if (!verify) return 'incomplete';

  const verifyStatus = stageStatusToken(verify);
  if (SUCCESSFUL_CLOSE_STATUSES.has(verifyStatus)) return 'completed';
  if (DEFERRED_STAGE_STATUSES.has(verifyStatus)) return 'deferred';
  if (FAILED_STAGE_STATUSES.has(verifyStatus)) return 'failed';
  return 'incomplete';
}

async function checkpointIfConfigured(input, context, stage, result, nextStep) {
  const sessionState = context.sessionState;
  if (!sessionState) return null;

  const pullRequestUrl = context.pullRequest?.url || null;
  const checkpoint = buildCodeThreadCheckpoint({
    issueIdentifier: input.issue?.identifier || input.issueIdentifier,
    branch: context.branch || input.branch,
    stage,
    lastDecision: result?.decision || result?.status || null,
    nextStep,
    artifact: {
      kind: pullRequestUrl ? 'pull-request' : 'paperclip-issue',
      issueIdentifier: input.issue?.identifier || input.issueIdentifier,
      branch: context.branch || input.branch,
      url: pullRequestUrl || input.issue?.url,
    },
  });

  await writeJarvosSessionState(sessionState, checkpoint);
  return checkpoint;
}

function reattachmentPayload(context) {
  if (!context.reattachment && !context.pullRequest) return null;
  return {
    branch: context.branch || null,
    pullRequest: context.pullRequest || null,
    sessionId: context.reattachment?.sessionId || null,
    worktreePath: context.reattachment?.worktreePath || null,
  };
}

async function runTakeIssueToDone(input = {}, adapters = {}) {
  const issueIdentifier = input.issue?.identifier || input.issueIdentifier;
  if (!issueIdentifier) throw new Error('take-issue-to-done orchestration requires an issue identifier');

  const reviewEngine = assertReviewEngineAdapter(adapters.reviewEngine);
  const controlPlane = input.controlPlane && typeof input.controlPlane === 'object'
    ? input.controlPlane
    : null;

  const context = {
    branch: input.branch || input.branchName || `${issueIdentifier}/take-issue-to-done`,
    baseRef: input.baseRef || 'origin/main',
    sessionState: adapters.sessionState || null,
    pullRequest: null,
    reattachment: null,
  };
  const entrySessionState = context.sessionState
    ? await readJarvosSessionState(context.sessionState).catch(() => null)
    : null;
  const resumePlan = resolveResumePlan(input, entrySessionState);
  if (resumePlan.branch) context.branch = resumePlan.branch;
  if (resumePlan.pullRequest) context.pullRequest = resumePlan.pullRequest;
  context.reattachment = resumePlan.reattachment;

  const events = [];
  const checkpoints = [];
  const stageResults = {};
  const reattach = reattachmentPayload(context);

  const runStage = async (stage, action, options = {}) => {
    const index = TAKE_ISSUE_TO_DONE_STAGES.indexOf(stage);
    // Always execute the stage through the live adapter (or revalidate). Resume
    // hints may avoid duplicate worktree/PR allocation inside adapters, but
    // never synthesize successful skipped-stage evidence here.
    assertFenceForStage(stage, controlPlane);
    const result = await action();
    assertFenceForStage(stage, controlPlane);

    const event = buildStageEvent(stage, result, {
      reattached: Boolean(reattach) && Boolean(result?.reattached),
    });
    events.push(event);
    stageResults[stage] = result;
    if (typeof options.beforeCheckpoint === 'function') {
      options.beforeCheckpoint(result);
    }
    const checkpoint = await checkpointIfConfigured(
      input,
      context,
      stage,
      event,
      stageNextStep(stage, index),
    );
    if (checkpoint) checkpoints.push(checkpoint);
    return result;
  };

  const claim = await runStage('claim', () => requireFn(adapters.tracker, 'claimIssue', 'claim')({
    issue: input.issue,
    issueIdentifier,
    controlPlane,
    reattach,
  }));

  const branch = await runStage('branch', () => requireFn(adapters.git, 'createBranch', 'branch')({
    issue: input.issue,
    issueIdentifier,
    baseRef: context.baseRef,
    branch: context.branch,
    claim,
    controlPlane,
    reattach,
    existingBranch: context.branch,
  }));
  context.branch = branch?.branch || branch?.name || context.branch;

  const sliceReview = await runStage('sliceReview', () => reviewEngine.sliceReview({
    issue: input.issue,
    issueIdentifier,
    branch: context.branch,
    baseRef: context.baseRef,
    branchResult: branch,
    controlPlane,
    reattach,
  }));

  const holisticReview = await runStage('holisticReview', () => reviewEngine.holisticReview({
    issue: input.issue,
    issueIdentifier,
    branch: context.branch,
    baseRef: context.baseRef,
    sliceReview,
    controlPlane,
    reattach,
  }));

  const fixRerun = await runStage('fixRerun', () => requireFn(adapters.fixer, 'fixAndRerun', 'fixRerun')({
    issue: input.issue,
    issueIdentifier,
    branch: context.branch,
    baseRef: context.baseRef,
    branchResult: branch,
    worktreeDir: branch?.worktreeDir || null,
    reviews: {
      sliceReview,
      holisticReview,
    },
    controlPlane,
    reattach,
  }));

  const pullRequest = await runStage('pullRequest', () => requireFn(adapters.pullRequest, 'openPullRequest', 'pullRequest')({
    issue: input.issue,
    issueIdentifier,
    branch: context.branch,
    baseRef: context.baseRef,
    fixRerun,
    controlPlane,
    fence: controlPlane?.fence,
    assertCurrentFence: controlPlane?.assertCurrentFence,
    reattach,
    existingPullRequest: context.pullRequest,
  }), {
    beforeCheckpoint: (result) => {
      context.pullRequest = result || context.pullRequest;
    },
  });
  context.pullRequest = pullRequest || context.pullRequest;

  const postMergeSweep = await runStage('postMergeSweep', () => requireFn(adapters.postMerge, 'sweep', 'postMergeSweep')({
    issue: input.issue,
    issueIdentifier,
    branch: context.branch,
    pullRequest: context.pullRequest,
    controlPlane,
    fence: controlPlane?.fence,
    assertCurrentFence: controlPlane?.assertCurrentFence,
    reattach,
  }));

  await runStage('verifyClose', () => requireFn(adapters.tracker, 'verifyAndClose', 'verifyClose')({
    issue: input.issue,
    issueIdentifier,
    branch: context.branch,
    pullRequest: context.pullRequest,
    postMergeSweep,
    controlPlane,
    fence: controlPlane?.fence,
    assertCurrentFence: controlPlane?.assertCurrentFence,
    reattach,
  }));

  const status = deriveOrchestratorStatus(events);

  return {
    schemaVersion: ORCHESTRATOR_SCHEMA_VERSION,
    status,
    issueIdentifier,
    branch: context.branch,
    continuity: {
      read: entrySessionState || null,
      resumeFrom: resumePlan.resume || null,
      reattachment: resumePlan.reattachment || null,
      // Always 0 under the safe contract — stages are never skipped as complete.
      resumedFromStageIndex: 0,
    },
    events,
    checkpoints,
  };
}

module.exports = {
  ORCHESTRATOR_SCHEMA_VERSION,
  TAKE_ISSUE_TO_DONE_STAGES,
  FENCED_MUTATION_STAGES,
  REATTACHMENT_HINT_KEYS,
  runTakeIssueToDone,
  resolveResumePlan,
  extractReattachmentHints,
  deriveOrchestratorStatus,
};
