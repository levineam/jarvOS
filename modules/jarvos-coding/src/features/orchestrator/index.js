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

function normalizeStageName(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  if (raw === 'complete' || raw === 'completed') return 'complete';
  if (TAKE_ISSUE_TO_DONE_STAGES.includes(raw)) return raw;
  const aliases = {
    claimIssue: 'claim',
    createBranch: 'branch',
    slice: 'sliceReview',
    holistic: 'holisticReview',
    fix: 'fixRerun',
    pr: 'pullRequest',
    pull_request: 'pullRequest',
    sweep: 'postMergeSweep',
    postMerge: 'postMergeSweep',
    close: 'verifyClose',
    verify: 'verifyClose',
    phase: null,
  };
  if (Object.prototype.hasOwnProperty.call(aliases, raw)) return aliases[raw];
  return null;
}

function firstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== '');
}

/**
 * Resolve resume pointers from explicit resumeFrom/checkpoint or session state.
 * Returns the index of the first stage that still needs to run, plus rehydrated
 * branch/PR context so later stages do not re-open worktrees/PRs blindly.
 */
function resolveResumePlan(input = {}, entrySessionState = null) {
  const candidates = [
    input.resumeFrom,
    input.checkpoint,
    entrySessionState?.state,
    entrySessionState?.state?.codeThread ? entrySessionState.state : null,
  ].filter((value) => value && typeof value === 'object');

  let resume = null;
  for (const candidate of candidates) {
    if (candidate.codeThread || candidate.stage || candidate.phase || candidate.nextStep || candidate.events) {
      resume = candidate;
      break;
    }
  }
  if (!resume) {
    return {
      startIndex: 0,
      branch: input.branch || input.branchName || null,
      pullRequest: null,
      priorResults: {},
      resume: null,
    };
  }

  const codeThread = resume.codeThread && typeof resume.codeThread === 'object' ? resume.codeThread : {};
  const nextStep = normalizeStageName(resume.nextStep || codeThread.nextStep);
  const completedStage = normalizeStageName(
    resume.stage || resume.phase || codeThread.stage || resume.loopStage,
  );

  let startIndex = 0;
  if (nextStep === 'complete') {
    startIndex = TAKE_ISSUE_TO_DONE_STAGES.length;
  } else if (nextStep && TAKE_ISSUE_TO_DONE_STAGES.includes(nextStep)) {
    startIndex = TAKE_ISSUE_TO_DONE_STAGES.indexOf(nextStep);
  } else if (completedStage && TAKE_ISSUE_TO_DONE_STAGES.includes(completedStage)) {
    startIndex = TAKE_ISSUE_TO_DONE_STAGES.indexOf(completedStage) + 1;
  }

  const priorResults = {};
  if (Array.isArray(resume.events)) {
    for (const event of resume.events) {
      if (event && event.stage) priorResults[event.stage] = event.result || event;
    }
  }
  for (const stage of TAKE_ISSUE_TO_DONE_STAGES) {
    if (resume[stage]) priorResults[stage] = resume[stage];
  }
  if (resume.claim) priorResults.claim = resume.claim;
  if (resume.branchResult) priorResults.branch = resume.branchResult;

  const prUrl = firstDefined(
    resume.pr,
    resume.prUrl,
    resume.pullRequest?.url,
    resume.pullRequestUrl,
    codeThread.pr,
    resume.artifact?.url,
  );
  const pullRequest = resume.pullRequest
    || (prUrl ? { status: 'exists', url: prUrl, reattached: true, ok: true } : null)
    || priorResults.pullRequest
    || null;
  if (pullRequest) priorResults.pullRequest = pullRequest;

  const branch = firstDefined(
    input.branch,
    input.branchName,
    resume.branch,
    codeThread.branch,
    resume.artifact?.branch,
    priorResults.branch?.branch,
    priorResults.branch?.name,
  );

  return {
    startIndex,
    branch: branch || null,
    pullRequest,
    priorResults,
    resume,
  };
}

function rehydrateSkippedResult(stage, plan, context) {
  if (plan.priorResults[stage]) return { ...plan.priorResults[stage], reattached: true };

  switch (stage) {
    case 'claim':
      return { status: 'claimed', reattached: true, ok: true };
    case 'branch':
      return { status: 'exists', branch: context.branch, reattached: true, ok: true };
    case 'sliceReview':
    case 'holisticReview':
      return { status: 'passed', reattached: true, summary: `reattached ${stage}` };
    case 'fixRerun':
      return { status: 'passed', reattached: true };
    case 'pullRequest':
      return plan.pullRequest || {
        status: 'exists',
        url: null,
        branch: context.branch,
        reattached: true,
        ok: true,
      };
    case 'postMergeSweep':
      return { status: 'completed', reattached: true };
    case 'verifyClose':
      return { status: 'verified', reattached: true, alreadyClosed: true, ok: true };
    default:
      return { status: 'reattached', reattached: true };
  }
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

  const checkpoint = buildCodeThreadCheckpoint({
    issueIdentifier: input.issue?.identifier || input.issueIdentifier,
    branch: context.branch || input.branch,
    stage,
    lastDecision: result?.decision || result?.status || null,
    nextStep,
    artifact: {
      kind: 'paperclip-issue',
      issueIdentifier: input.issue?.identifier || input.issueIdentifier,
      branch: context.branch || input.branch,
      url: input.issue?.url || context.pullRequest?.url,
    },
  });

  await writeJarvosSessionState(sessionState, checkpoint);
  return checkpoint;
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
  };
  const entrySessionState = context.sessionState
    ? await readJarvosSessionState(context.sessionState).catch(() => null)
    : null;
  const resumePlan = resolveResumePlan(input, entrySessionState);
  if (resumePlan.branch) context.branch = resumePlan.branch;
  if (resumePlan.pullRequest) context.pullRequest = resumePlan.pullRequest;

  const events = [];
  const checkpoints = [];
  const stageResults = {};

  const runStage = async (stage, action) => {
    const index = TAKE_ISSUE_TO_DONE_STAGES.indexOf(stage);
    let result;
    let reattached = false;

    if (index < resumePlan.startIndex) {
      reattached = true;
      result = rehydrateSkippedResult(stage, resumePlan, context);
    } else {
      assertFenceForStage(stage, controlPlane);
      result = await action();
      assertFenceForStage(stage, controlPlane);
    }

    const event = buildStageEvent(stage, result, { reattached });
    events.push(event);
    stageResults[stage] = result;
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
  }));

  const branch = await runStage('branch', () => requireFn(adapters.git, 'createBranch', 'branch')({
    issue: input.issue,
    issueIdentifier,
    baseRef: context.baseRef,
    branch: context.branch,
    claim,
    controlPlane,
  }));
  context.branch = branch?.branch || branch?.name || context.branch;

  const sliceReview = await runStage('sliceReview', () => reviewEngine.sliceReview({
    issue: input.issue,
    issueIdentifier,
    branch: context.branch,
    baseRef: context.baseRef,
    branchResult: branch,
    controlPlane,
  }));

  const holisticReview = await runStage('holisticReview', () => reviewEngine.holisticReview({
    issue: input.issue,
    issueIdentifier,
    branch: context.branch,
    baseRef: context.baseRef,
    sliceReview,
    controlPlane,
  }));

  const fixRerun = await runStage('fixRerun', () => requireFn(adapters.fixer, 'fixAndRerun', 'fixRerun')({
    issue: input.issue,
    issueIdentifier,
    branch: context.branch,
    baseRef: context.baseRef,
    reviews: {
      sliceReview,
      holisticReview,
    },
    controlPlane,
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
  }));
  context.pullRequest = pullRequest || context.pullRequest;

  const postMergeSweep = await runStage('postMergeSweep', () => requireFn(adapters.postMerge, 'sweep', 'postMergeSweep')({
    issue: input.issue,
    issueIdentifier,
    branch: context.branch,
    pullRequest: context.pullRequest,
    controlPlane,
    fence: controlPlane?.fence,
    assertCurrentFence: controlPlane?.assertCurrentFence,
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
      resumedFromStageIndex: resumePlan.startIndex,
    },
    events,
    checkpoints,
  };
}

module.exports = {
  ORCHESTRATOR_SCHEMA_VERSION,
  TAKE_ISSUE_TO_DONE_STAGES,
  FENCED_MUTATION_STAGES,
  runTakeIssueToDone,
  resolveResumePlan,
  deriveOrchestratorStatus,
};
