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

function buildStageEvent(stage, result) {
  return {
    stage,
    status: result?.status || (result?.ok === false ? 'failed' : 'completed'),
    result: result || null,
  };
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
      url: input.issue?.url,
    },
  });

  await writeJarvosSessionState(sessionState, checkpoint);
  return checkpoint;
}

async function runTakeIssueToDone(input = {}, adapters = {}) {
  const issueIdentifier = input.issue?.identifier || input.issueIdentifier;
  if (!issueIdentifier) throw new Error('take-issue-to-done orchestration requires an issue identifier');

  const reviewEngine = assertReviewEngineAdapter(adapters.reviewEngine);
  const context = {
    branch: input.branch || input.branchName || `${issueIdentifier}/take-issue-to-done`,
    baseRef: input.baseRef || 'origin/main',
    sessionState: adapters.sessionState || null,
  };
  const entrySessionState = context.sessionState
    ? await readJarvosSessionState(context.sessionState).catch(() => null)
    : null;
  const events = [];
  const checkpoints = [];

  const runStage = async (stage, action) => {
    const index = TAKE_ISSUE_TO_DONE_STAGES.indexOf(stage);
    const result = await action();
    const event = buildStageEvent(stage, result);
    events.push(event);
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
  }));

  const branch = await runStage('branch', () => requireFn(adapters.git, 'createBranch', 'branch')({
    issue: input.issue,
    issueIdentifier,
    baseRef: context.baseRef,
    branch: context.branch,
    claim,
  }));
  context.branch = branch?.branch || branch?.name || context.branch;

  const sliceReview = await runStage('sliceReview', () => reviewEngine.sliceReview({
    issue: input.issue,
    issueIdentifier,
    branch: context.branch,
    baseRef: context.baseRef,
    branchResult: branch,
  }));

  const holisticReview = await runStage('holisticReview', () => reviewEngine.holisticReview({
    issue: input.issue,
    issueIdentifier,
    branch: context.branch,
    baseRef: context.baseRef,
    sliceReview,
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
  }));

  const pullRequest = await runStage('pullRequest', () => requireFn(adapters.pullRequest, 'openPullRequest', 'pullRequest')({
    issue: input.issue,
    issueIdentifier,
    branch: context.branch,
    baseRef: context.baseRef,
    fixRerun,
  }));

  const postMergeSweep = await runStage('postMergeSweep', () => requireFn(adapters.postMerge, 'sweep', 'postMergeSweep')({
    issue: input.issue,
    issueIdentifier,
    branch: context.branch,
    pullRequest,
  }));

  await runStage('verifyClose', () => requireFn(adapters.tracker, 'verifyAndClose', 'verifyClose')({
    issue: input.issue,
    issueIdentifier,
    branch: context.branch,
    pullRequest,
    postMergeSweep,
  }));

  return {
    schemaVersion: ORCHESTRATOR_SCHEMA_VERSION,
    status: 'completed',
    issueIdentifier,
    branch: context.branch,
    continuity: {
      read: entrySessionState || null,
    },
    events,
    checkpoints,
  };
}

module.exports = {
  ORCHESTRATOR_SCHEMA_VERSION,
  TAKE_ISSUE_TO_DONE_STAGES,
  runTakeIssueToDone,
};
