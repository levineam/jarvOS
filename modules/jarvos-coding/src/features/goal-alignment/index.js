'use strict';

const GOAL_ALIGNMENT_SCHEMA_VERSION = 'jarvos-coding-goal-alignment/v1';

const ALIGNED_STATUSES = Object.freeze(['aligned', 'passed', 'approved', 'clean']);
const UNCLEAR_STATUSES = Object.freeze(['unclear', 'ambiguous', 'needs_clarification', 'needs-clarification', 'blocked']);
const UNCLEAR_TEXT_RE = /\b(unclear|ambiguous|not sure|cannot determine|can't determine|needs clarification|goal clarity|scope unclear|out of scope\?)\b/i;
const ALIGNED_TEXT_RE = /\b(aligned|aligns|matches|satisfies|implements)\b/i;

function compactWhitespace(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function truncate(value, max = 180) {
  const text = compactWhitespace(value);
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}...`;
}

function prUrlForGoalAlignment(detail = {}) {
  if (detail.url) return detail.url;
  if (detail.repo && detail.number) return `https://github.com/${detail.repo}/pull/${detail.number}`;
  return '';
}

function issueLabel(issue = {}) {
  return issue.identifier || issue.key || issue.id || 'the tracked issue';
}

function goalText(input = {}) {
  return compactWhitespace(
    input.goal?.title
    || input.goal
    || input.issue?.goal
    || input.issue?.goalTitle
    || input.issue?.title
    || '',
  );
}

function issuePlanText(input = {}) {
  const planDocs = Array.isArray(input.planDocuments)
    ? input.planDocuments.map((doc) => doc?.body || doc?.text || doc?.content || doc).join('\n')
    : '';
  const linkedPlans = Array.isArray(input.linkedPlans)
    ? input.linkedPlans.map((doc) => doc?.body || doc?.text || doc?.content || doc).join('\n')
    : '';
  return compactWhitespace([
    input.issue?.description,
    input.issue?.plan,
    input.issue?.doneCriteria,
    planDocs,
    linkedPlans,
  ].filter(Boolean).join('\n'));
}

function changeText(input = {}) {
  const pr = input.pullRequest || input.pr || {};
  const files = Array.isArray(input.files)
    ? input.files.map((file) => file.filename || file.path || file).join(', ')
    : '';
  return compactWhitespace([
    pr.title,
    pr.body,
    pr.summary,
    input.diffSummary,
    files,
  ].filter(Boolean).join('\n'));
}

function suppliedReview(input = {}) {
  return input.review || input.goalAlignment || input.checks?.goalAlignment || null;
}

function suppliedQuestion(review) {
  if (!review || typeof review !== 'object') return '';
  return compactWhitespace(review.question || review.goalClarityQuestion || review.specificQuestion);
}

function buildGoalClarityQuestion(input = {}, reason = 'goal alignment is unclear') {
  const issue = input.issue || {};
  const pr = input.pullRequest || input.pr || {};
  const issueRef = issueLabel(issue);
  const goal = goalText(input);
  const change = changeText(input);
  const prRef = prUrlForGoalAlignment(pr) || (pr.repo && pr.number ? `${pr.repo}#${pr.number}` : 'this PR');
  const goalClause = goal ? ` for goal "${truncate(goal, 120)}"` : '';
  const changeClause = change ? ` The PR appears to change: ${truncate(change, 160)}.` : '';
  return `Should ${prRef} be considered in scope for ${issueRef}${goalClause}? ${reason}.${changeClause}`;
}

function normalizeGoalAlignmentReview(input = {}) {
  const review = suppliedReview(input);
  const reviewText = typeof review === 'string'
    ? review
    : compactWhitespace([
      review?.status,
      review?.state,
      review?.summary,
      review?.rationale,
      suppliedQuestion(review),
    ].filter(Boolean).join(' '));
  const status = typeof review === 'object' && review
    ? compactWhitespace(review.status || review.state).toLowerCase()
    : '';
  const question = suppliedQuestion(review);

  return {
    schemaVersion: GOAL_ALIGNMENT_SCHEMA_VERSION,
    issueIdentifier: issueLabel(input.issue || {}),
    prUrl: prUrlForGoalAlignment(input.pullRequest || input.pr || {}),
    hasIssuePlan: issuePlanText(input).length > 0,
    hasGoal: goalText(input).length > 0,
    hasChangeSummary: changeText(input).length > 0,
    reviewStatus: status,
    reviewText: compactWhitespace(reviewText),
    question,
  };
}

function evaluateGoalAlignment(input = {}) {
  const normalized = normalizeGoalAlignmentReview(input);
  const status = normalized.reviewStatus;
  const reviewText = normalized.reviewText;
  const hasReviewerSignal = Boolean(status || reviewText);

  if (UNCLEAR_STATUSES.includes(status) || UNCLEAR_TEXT_RE.test(reviewText)) {
    const reason = normalized.question
      ? 'the reviewer supplied a goal-clarity question'
      : 'the goal-alignment review is ambiguous';
    return {
      schemaVersion: GOAL_ALIGNMENT_SCHEMA_VERSION,
      status: 'unclear',
      decision: 'escalate_to_andrew',
      mergeAllowed: false,
      reason,
      question: normalized.question || buildGoalClarityQuestion(input, reason),
      normalized,
    };
  }

  if (
    ALIGNED_STATUSES.includes(status)
    || (/\bgoal[-\s]?alignment(?:\s+review)?\b/i.test(reviewText) && ALIGNED_TEXT_RE.test(reviewText))
    || /\baligned\s+with\s+(?:the\s+)?(?:issue\s+)?(?:goal|plan|done criteria|[A-Z]+-\d+)/i.test(reviewText)
  ) {
    return {
      schemaVersion: GOAL_ALIGNMENT_SCHEMA_VERSION,
      status: 'aligned',
      decision: 'allow_autonomous_merge',
      mergeAllowed: true,
      reason: 'explicit goal-alignment evidence recorded',
      normalized,
    };
  }

  if (!normalized.hasIssuePlan && !normalized.hasGoal) {
    const reason = 'no issue plan or goal context is available for comparison';
    return {
      schemaVersion: GOAL_ALIGNMENT_SCHEMA_VERSION,
      status: 'unclear',
      decision: 'escalate_to_andrew',
      mergeAllowed: false,
      reason,
      question: buildGoalClarityQuestion(input, reason),
      normalized,
    };
  }

  if (!hasReviewerSignal) {
    const reason = 'no AI goal-alignment review has been recorded';
    return {
      schemaVersion: GOAL_ALIGNMENT_SCHEMA_VERSION,
      status: 'missing',
      decision: 'block_merge',
      mergeAllowed: false,
      reason,
      question: buildGoalClarityQuestion(input, reason),
      normalized,
    };
  }

  const reason = 'review evidence does not clearly say whether the PR matches the issue goal';
  return {
    schemaVersion: GOAL_ALIGNMENT_SCHEMA_VERSION,
    status: 'unclear',
    decision: 'escalate_to_andrew',
    mergeAllowed: false,
    reason,
    question: buildGoalClarityQuestion(input, reason),
    normalized,
  };
}

function buildGoalClarityEscalation(issue = {}, detail = {}, review = {}) {
  const evaluation = review.schemaVersion === GOAL_ALIGNMENT_SCHEMA_VERSION
    ? review
    : evaluateGoalAlignment({ issue, pullRequest: detail, goalAlignment: review });
  const question = compactWhitespace(evaluation.question)
    || buildGoalClarityQuestion({ issue, pullRequest: detail }, evaluation.reason);
  return {
    kind: 'request_confirmation',
    payload: {
      version: 1,
      purpose: 'goal_clarity',
      prompt: `Goal clarity needed before autonomous merge: ${question}`,
      question,
      issueIdentifier: issueLabel(issue),
      prUrl: prUrlForGoalAlignment(detail),
      blocksAutonomousMerge: true,
      distinctFromRoutineApproval: true,
      allowDeclineReason: true,
    },
  };
}

function isGoalClarityInteraction(interaction, issue = {}, detail = {}) {
  if (!interaction || interaction.kind !== 'request_confirmation') return false;
  if (String(interaction.status || '').toLowerCase() !== 'pending') return false;
  const payload = interaction.payload || {};
  if (payload.purpose !== 'goal_clarity') return false;
  const identifier = issueLabel(issue);
  const url = prUrlForGoalAlignment(detail);
  return (!identifier || payload.issueIdentifier === identifier)
    && (!url || payload.prUrl === url);
}

function findPendingGoalClarityInteraction(interactions, issue = {}, detail = {}) {
  if (!Array.isArray(interactions)) return null;
  return interactions.find((interaction) => isGoalClarityInteraction(interaction, issue, detail)) || null;
}

module.exports = {
  GOAL_ALIGNMENT_SCHEMA_VERSION,
  buildGoalClarityEscalation,
  buildGoalClarityQuestion,
  evaluateGoalAlignment,
  findPendingGoalClarityInteraction,
  isGoalClarityInteraction,
  normalizeGoalAlignmentReview,
};
