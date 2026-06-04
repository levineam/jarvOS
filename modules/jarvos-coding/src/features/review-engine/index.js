'use strict';

const REVIEW_ENGINE_SCHEMA_VERSION = 'jarvos-coding-review-engine/v1';
const DEFAULT_CLAWPATCH_COMMAND = Object.freeze(['clawpatch']);
const DEFAULT_AUTOREVIEW_COMMAND = Object.freeze(['autoreview']);
const DEFAULT_CLAWSWEEPER_COMMAND = Object.freeze(['clawsweeper']);

const GATE_EQUIVALENT_SURFACES = Object.freeze([
  'jarvos-repo',
  'codex-native',
  'hermes-hosted',
]);

const GATE_EQUIVALENT_PROFILES = Object.freeze({
  'jarvos-repo': Object.freeze({
    surface: 'jarvos-repo',
    name: 'jarvos-repo-pr-review-equivalents',
    description: 'Public jarvOS repository PRs where clawd-local clawpatch/autoreview cannot run inside the target repository.',
    equivalenceDecision: 'CodeRabbit counts as the slice-review equivalent and Codex GitHub review counts as the holistic-review equivalent only when both run on the PR head before merge and their evidence is linked on the tracker issue.',
    gates: Object.freeze({
      sliceReview: Object.freeze({
        key: 'clawpatch',
        equivalent: 'coderabbit-pr-slice-review',
        tool: 'coderabbit',
        role: 'PR-head diff and inline review that provides slice-scoped findings before merge.',
        command: Object.freeze(['gh', 'pr', 'comment', '{pullRequestNumber}', '--body', '@coderabbitai review']),
        evidence: Object.freeze([
          'CodeRabbit comment or successful CodeRabbit status on the current PR head SHA',
          'summary of accepted findings and fixes or explicit no-actionable-findings result',
        ]),
      }),
      holisticReview: Object.freeze({
        key: 'autoreview',
        equivalent: 'codex-github-pr-review',
        tool: 'codex-github',
        role: 'Whole-PR AI review against the current PR diff before merge.',
        command: Object.freeze(['gh', 'pr', 'comment', '{pullRequestNumber}', '--body', '@codex review']),
        evidence: Object.freeze([
          'Codex GitHub review comment on the current PR head SHA',
          'accepted/actionable findings fixed or clean-review result recorded before merge',
        ]),
      }),
      postMergeSweep: Object.freeze({
        key: 'post_merge_clawsweeper',
        equivalent: 'paperclip-post-merge-audit-queue',
        tool: 'paperclip-clawsweeper-routing',
        role: 'Merged commits are routed into the Paperclip follow-up queue from post-merge audit artifacts.',
        command: Object.freeze([
          'node',
          'scripts/clawsweeper-to-paperclip.js',
          '--summary',
          'clawsweeper-summary/clawsweeper-commit-review-summary.json',
          '--artifact-dir',
          'collected-clawsweeper-artifacts',
          '--parent-issue',
          '{issueIdentifier}',
        ]),
        evidence: Object.freeze([
          'Paperclip follow-up issue, rollup issue, or dry-run artifact keyed to merged commit SHA',
          'audit artifact path or not-applicable reason when the PR has not merged yet',
        ]),
      }),
    }),
  }),
  'codex-native': Object.freeze({
    surface: 'codex-native',
    name: 'codex-native-command-equivalents',
    description: 'Codex CLI/native workers operating in a local checkout with node scripts available.',
    equivalenceDecision: 'Codex-native workers use the same jarvos-coding command interface as other hosts; the commands wrap the clawd clawpatch/autoreview gates and preserve separate slice and holistic evidence.',
    gates: Object.freeze({
      sliceReview: Object.freeze({
        key: 'clawpatch',
        equivalent: 'post-subagent-clawpatch-advisory',
        tool: 'clawpatch',
        role: 'Pre-PR slice review and bounded fix loop on the branch diff.',
        command: Object.freeze(['node', 'scripts/post-subagent-clawpatch-advisory.js']),
        evidence: Object.freeze([
          '.clawpatch/runs/advisory-latest.json or command output summary',
          'unresolved critical findings fixed or explicitly triaged before PR creation',
        ]),
      }),
      holisticReview: Object.freeze({
        key: 'autoreview',
        equivalent: 'post-subagent-autoreview',
        tool: 'autoreview',
        role: 'Pre-PR holistic branch review using the vendored OpenClaw autoreview helper.',
        command: Object.freeze(['node', 'scripts/post-subagent-autoreview.js']),
        evidence: Object.freeze([
          '/tmp/clawd-autoreview artifact path or command output summary',
          'accepted/actionable findings fixed before PR creation',
        ]),
      }),
      postMergeSweep: Object.freeze({
        key: 'post_merge_clawsweeper',
        equivalent: 'clawsweeper-to-paperclip',
        tool: 'clawsweeper',
        role: 'Post-merge audit artifacts become Paperclip follow-up work.',
        command: Object.freeze([
          'node',
          'scripts/clawsweeper-to-paperclip.js',
          '--summary',
          'clawsweeper-summary/clawsweeper-commit-review-summary.json',
          '--artifact-dir',
          'collected-clawsweeper-artifacts',
          '--parent-issue',
          '{issueIdentifier}',
        ]),
        evidence: Object.freeze([
          'created Paperclip issue(s), rollup issue, or dry-run JSON artifact',
          'merged commit SHA and PR URL included in the audit source',
        ]),
      }),
    }),
  }),
  'hermes-hosted': Object.freeze({
    surface: 'hermes-hosted',
    name: 'hermes-hosted-dispatch-equivalents',
    description: 'Hermes sidecar executions where the host cannot run clawd gates inline but can dispatch bounded Paperclip work packets.',
    equivalenceDecision: 'Hermes satisfies the same jarvos-coding stages by dispatching explicit sliceReview, holisticReview, and postMergeSweep tasks through the Hermes/Paperclip bridge and returning normalized artifact evidence.',
    gates: Object.freeze({
      sliceReview: Object.freeze({
        key: 'clawpatch',
        equivalent: 'hermes-slice-review-dispatch',
        tool: 'hermes-sidecar',
        role: 'Hermes executes a bounded slice-review task against the branch diff before PR creation.',
        command: Object.freeze([
          'node',
          'scripts/hermes-paperclip-workflow.js',
          '{issueIdentifier}',
          '--no-checkout',
          '--task-summary',
          'Run jarvos-coding sliceReview equivalent for {issueIdentifier} on branch {branch} against {baseRef}; return findings, fixes, and artifact paths.',
        ]),
        evidence: Object.freeze([
          'Hermes completed result comment with sliceReview stage and artifact path',
          'findings fixed or explicit no-actionable-findings result before PR creation',
        ]),
      }),
      holisticReview: Object.freeze({
        key: 'autoreview',
        equivalent: 'hermes-holistic-review-dispatch',
        tool: 'hermes-sidecar',
        role: 'Hermes executes a bounded holistic branch-review task before PR creation.',
        command: Object.freeze([
          'node',
          'scripts/hermes-paperclip-workflow.js',
          '{issueIdentifier}',
          '--no-checkout',
          '--task-summary',
          'Run jarvos-coding holisticReview equivalent for {issueIdentifier} on branch {branch} against {baseRef}; compare the whole diff to the issue plan and return accepted/actionable findings.',
        ]),
        evidence: Object.freeze([
          'Hermes completed result comment with holisticReview stage and artifact path',
          'accepted/actionable findings fixed or clean-review result before PR creation',
        ]),
      }),
      postMergeSweep: Object.freeze({
        key: 'post_merge_clawsweeper',
        equivalent: 'hermes-post-merge-audit-dispatch',
        tool: 'hermes-sidecar',
        role: 'Hermes dispatches merged-commit audit work and returns the follow-up queue result.',
        command: Object.freeze([
          'node',
          'scripts/hermes-paperclip-workflow.js',
          '{issueIdentifier}',
          '--no-checkout',
          '--task-summary',
          'Run jarvos-coding postMergeSweep equivalent for merged PR {pullRequestNumber} / commit {mergeSha}; route actionable findings into Paperclip follow-up work.',
        ]),
        evidence: Object.freeze([
          'Hermes completed result comment with postMergeSweep stage and routed follow-up work',
          'Paperclip follow-up issue, rollup, or explicit no-findings artifact',
        ]),
      }),
    }),
  }),
});

function normalizeCommand(command, fallback) {
  if (Array.isArray(command) && command.length > 0) {
    return command.map((part) => String(part)).filter(Boolean);
  }
  if (typeof command === 'string' && command.trim()) return [command.trim()];
  return [...fallback];
}

function cloneCommand(command = []) {
  return Array.isArray(command) ? command.map((part) => String(part)) : [];
}

function interpolateCommand(command = [], input = {}) {
  const replacements = {
    base: input.base || input.baseRef || '',
    baseRef: input.baseRef || input.base || '',
    branch: input.branch || '',
    issueIdentifier: input.issueIdentifier || input.issue?.identifier || '',
    mergeSha: input.mergeSha || input.mergeCommit || input.pullRequest?.mergeSha || '',
    pullRequestNumber: input.pullRequestNumber || input.pullRequest?.number || '',
    pullRequestUrl: input.pullRequestUrl || input.pullRequest?.url || '',
  };

  return cloneCommand(command).map((part) => part.replace(/\{([a-zA-Z0-9_]+)\}/g, (match, key) => (
    Object.prototype.hasOwnProperty.call(replacements, key) && replacements[key]
      ? String(replacements[key])
      : match
  )));
}

function requireRunner(runner) {
  if (typeof runner !== 'function') {
    throw new Error('review engine runner is required');
  }
  return runner;
}

async function runReviewCommand(runner, payload) {
  const result = await requireRunner(runner)(payload);
  return {
    schemaVersion: REVIEW_ENGINE_SCHEMA_VERSION,
    engine: payload.engine,
    stage: payload.stage,
    tool: payload.tool,
    command: payload.command,
    status: result?.status || (result?.ok === false ? 'failed' : 'passed'),
    artifact: result?.artifact || result?.artifactPath || null,
    summary: result?.summary || '',
    raw: result || null,
  };
}

function createClawpatchAutoreviewAdapter(options = {}) {
  const clawpatchCommand = normalizeCommand(options.clawpatchCommand, DEFAULT_CLAWPATCH_COMMAND);
  const autoreviewCommand = normalizeCommand(options.autoreviewCommand, DEFAULT_AUTOREVIEW_COMMAND);
  const engine = options.name || 'clawpatch-autoreview';

  return createCommandReviewEngine({
    name: engine,
    runner: options.runner,
    commands: {
      sliceReview: (input = {}) => [
        ...clawpatchCommand,
        'review',
        ...(options.includeBase === false || !(input.since || input.baseRef)
          ? []
          : ['--since', input.since || input.baseRef]),
      ],
      holisticReview: (input = {}) => [
        ...autoreviewCommand,
        '--mode',
        'branch',
        ...(options.includeBase === false || !(input.baseRef || input.base)
          ? []
          : ['--base', input.baseRef || input.base]),
      ],
    },
    tools: {
      sliceReview: 'clawpatch',
      holisticReview: 'autoreview',
    },
  });
}

function createCommandReviewEngine(options = {}) {
  const runner = options.runner;
  const engine = options.name || 'command-review-engine';
  const commands = options.commands || {};
  const tools = options.tools || {};

  const stageCommand = (stage, input, fallback = []) => {
    const command = commands[stage];
    if (typeof command === 'function') return normalizeCommand(command(input), fallback);
    return normalizeCommand(command, fallback);
  };
  const stageTool = (stage, fallback) => String(tools[stage] || fallback);

  return {
    schemaVersion: REVIEW_ENGINE_SCHEMA_VERSION,
    name: engine,
    tools: Object.freeze([
      stageTool('sliceReview', 'slice-review'),
      stageTool('holisticReview', 'holistic-review'),
      stageTool('postMergeSweep', 'post-merge-audit'),
    ]),

    async sliceReview(input = {}) {
      return runReviewCommand(runner, {
        engine,
        stage: 'sliceReview',
        tool: stageTool('sliceReview', 'slice-review'),
        command: interpolateCommand(stageCommand('sliceReview', input), input),
        input,
      });
    },

    async holisticReview(input = {}) {
      return runReviewCommand(runner, {
        engine,
        stage: 'holisticReview',
        tool: stageTool('holisticReview', 'holistic-review'),
        command: interpolateCommand(stageCommand('holisticReview', input), input),
        input,
      });
    },

    async postMergeSweep(input = {}) {
      return runReviewCommand(runner, {
        engine,
        stage: 'postMergeSweep',
        tool: stageTool('postMergeSweep', 'post-merge-audit'),
        command: interpolateCommand(stageCommand('postMergeSweep', input, DEFAULT_CLAWSWEEPER_COMMAND), input),
        input,
      });
    },
  };
}

function getGateEquivalentProfile(surface) {
  const normalized = String(surface || '').trim().toLowerCase();
  const profile = GATE_EQUIVALENT_PROFILES[normalized];
  if (!profile) {
    throw new Error(`unsupported gate equivalent surface: ${surface}`);
  }
  return profile;
}

function buildGateEquivalentCommands(surface, input = {}) {
  const profile = getGateEquivalentProfile(surface);
  return {
    surface: profile.surface,
    name: profile.name,
    equivalenceDecision: profile.equivalenceDecision,
    commands: Object.fromEntries(Object.entries(profile.gates).map(([stage, gate]) => [
      stage,
      {
        key: gate.key,
        equivalent: gate.equivalent,
        tool: gate.tool,
        command: interpolateCommand(gate.command, input),
        evidence: [...gate.evidence],
      },
    ])),
  };
}

function createGateEquivalentReviewEngine(surface, options = {}) {
  const profile = getGateEquivalentProfile(surface);
  const commands = Object.fromEntries(Object.entries(profile.gates).map(([stage, gate]) => [
    stage,
    gate.command,
  ]));
  const tools = Object.fromEntries(Object.entries(profile.gates).map(([stage, gate]) => [
    stage,
    gate.tool,
  ]));

  return createCommandReviewEngine({
    name: options.name || profile.name,
    runner: options.runner,
    commands,
    tools,
  });
}

function assertReviewEngineAdapter(adapter) {
  if (!adapter || typeof adapter !== 'object') {
    throw new Error('review engine adapter is required');
  }
  if (typeof adapter.sliceReview !== 'function') {
    throw new Error('review engine adapter must implement sliceReview(input)');
  }
  if (typeof adapter.holisticReview !== 'function') {
    throw new Error('review engine adapter must implement holisticReview(input)');
  }
  return adapter;
}

module.exports = {
  GATE_EQUIVALENT_PROFILES,
  GATE_EQUIVALENT_SURFACES,
  REVIEW_ENGINE_SCHEMA_VERSION,
  assertReviewEngineAdapter,
  buildGateEquivalentCommands,
  createCommandReviewEngine,
  createClawpatchAutoreviewAdapter,
  createGateEquivalentReviewEngine,
  getGateEquivalentProfile,
  interpolateCommand,
};
