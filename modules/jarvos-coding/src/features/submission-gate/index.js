'use strict';

const SUBMISSION_GATE_SCHEMA_VERSION = 'jarvos-coding-submission-gate/v1';

const REQUIRED_EVIDENCE = Object.freeze([
  {
    key: 'issue',
    label: 'Paperclip issue',
    description: 'A durable issue identifier exists before code work starts.',
  },
  {
    key: 'branch',
    label: 'Issue-named feature branch',
    description: 'The branch is not main/master and includes the issue identifier.',
  },
  {
    key: 'tests',
    label: 'Focused tests',
    description: 'Relevant tests, lint, build, smoke, or an explicit no-test rationale are recorded.',
  },
  {
    key: 'clawpatch',
    label: 'clawpatch advisory',
    description: 'clawpatch ran before PR creation, or a documented kill-switch/intake-only exception exists.',
  },
  {
    key: 'autoreview',
    label: 'Local autoreview',
    description: 'Local autoreview ran before PR creation and accepted/actionable findings were fixed.',
  },
  {
    key: 'pullRequest',
    label: 'Pull request evidence',
    description: 'A PR URL/number exists, or the task is explicitly marked intake-only with no code submission.',
  },
]);

function normalizeIdentifier(identifier = '') {
  const match = String(identifier || '').match(/\b([A-Z][A-Z0-9]+-\d+)\b/i);
  return match ? match[1].toUpperCase() : '';
}

function normalizeMode(mode = 'code-submission') {
  return mode === 'intake-only' ? 'intake-only' : 'code-submission';
}

function buildSubmissionGate({ identifier = 'SUP-XX', mode = 'code-submission' } = {}) {
  const normalizedIdentifier = normalizeIdentifier(identifier) || 'SUP-XX';
  const normalizedMode = normalizeMode(mode);

  return {
    schemaVersion: SUBMISSION_GATE_SCHEMA_VERSION,
    mode: normalizedMode,
    identifier: normalizedIdentifier,
    decision: normalizedMode === 'intake-only' ? 'document-exception' : 'fail-closed',
    requirements: REQUIRED_EVIDENCE.map((item) => ({ ...item })),
    evidenceKeys: REQUIRED_EVIDENCE.map((item) => item.key),
  };
}

function evidenceValuePresent(value) {
  if (Array.isArray(value)) return value.some(evidenceValuePresent);
  if (value && typeof value === 'object') {
    if (Object.prototype.hasOwnProperty.call(value, 'ok') && value.ok === false) return false;
    return Object.values(value).some(evidenceValuePresent);
  }
  return String(value || '').trim().length > 0;
}

function branchSatisfiesIdentifier(branch = '', identifier = '') {
  const normalizedBranch = String(branch || '').trim();
  const normalizedIdentifier = normalizeIdentifier(identifier);
  if (!normalizedBranch || normalizedBranch === 'HEAD') return false;
  if (/^(main|master)$/i.test(normalizedBranch)) return false;
  if (!normalizedIdentifier) return false;
  const branchIdentifiers = normalizedBranch.match(/\b[A-Z][A-Z0-9]+-\d+\b/gi) || [];
  return branchIdentifiers.some((branchIdentifier) => normalizeIdentifier(branchIdentifier) === normalizedIdentifier);
}

function issueSatisfiesIdentifier(issueEvidence, identifier = '') {
  const normalizedIdentifier = normalizeIdentifier(identifier);
  if (!normalizedIdentifier) return false;

  if (typeof issueEvidence === 'string') {
    return normalizeIdentifier(issueEvidence) === normalizedIdentifier;
  }

  if (!issueEvidence || typeof issueEvidence !== 'object') return false;

  const candidateFields = [
    issueEvidence.identifier,
    issueEvidence.issueIdentifier,
    issueEvidence.ref,
    issueEvidence.key,
  ];

  return candidateFields.some((candidate) => normalizeIdentifier(candidate) === normalizedIdentifier);
}

function validateSubmissionEvidence(evidence = {}, options = {}) {
  const gate = buildSubmissionGate(options);

  if (gate.mode === 'intake-only') {
    return {
      schemaVersion: gate.schemaVersion,
      ok: true,
      mode: gate.mode,
      decision: 'document-exception',
      missing: [],
      reasons: ['intake-only mode does not submit code'],
      evidenceKeys: gate.evidenceKeys,
    };
  }

  const missing = [];
  const reasons = [];

  for (const key of gate.evidenceKeys) {
    if (!evidenceValuePresent(evidence[key])) {
      missing.push(key);
      reasons.push(`${key} evidence is missing`);
    }
  }

  if (!branchSatisfiesIdentifier(evidence.branch, gate.identifier)) {
    if (!missing.includes('branch')) missing.push('branch');
    reasons.push(`branch must include ${gate.identifier} and must not be main/master/HEAD`);
  }

  if (!issueSatisfiesIdentifier(evidence.issue, gate.identifier)) {
    if (!missing.includes('issue')) missing.push('issue');
    reasons.push(`issue evidence must match ${gate.identifier}`);
  }

  return {
    schemaVersion: gate.schemaVersion,
    ok: missing.length === 0,
    mode: gate.mode,
    decision: missing.length === 0 ? 'continue' : 'fail-closed',
    missing,
    reasons,
    evidenceKeys: gate.evidenceKeys,
  };
}

function formatSubmissionGateMarkdown({ identifier = 'SUP-XX', mode = 'code-submission' } = {}) {
  const gate = buildSubmissionGate({ identifier, mode });
  const requirementLines = gate.requirements.map((item, index) => (
    `${index + 1}. **${item.label}** - ${item.description}`
  ));

  return `## jarvos-coding Submission Gate

Schema: \`${gate.schemaVersion}\`
Decision mode: \`${gate.decision}\`

This is an agent-agnostic OpenClaw code submission gate. It applies to Michael, Charlie, Codex-native subagents, and future code-producing agents.

Required evidence before reporting code work complete:
${requirementLines.join('\n')}

Tool roles:
- \`clawpatch\`: slice-scoped advisory review and bounded fix loop before PR creation.
- \`autoreview\`: local branch gate before PR creation; accepted/actionable findings block submission until fixed.
- Tests: focused command output or explicit no-test rationale tied to the changed surface.
- Pull request: durable PR URL/number and branch evidence for review/CI.
- \`clawsweeper\`: post-merge sweep only; it must not replace pre-submit clawpatch, autoreview, tests, or PR evidence.

If any required evidence is missing, fail closed and update the Paperclip issue as blocked or mark the task \`intake-only\` with the reason no code was submitted.`;
}

module.exports = {
  REQUIRED_EVIDENCE,
  SUBMISSION_GATE_SCHEMA_VERSION,
  branchSatisfiesIdentifier,
  buildSubmissionGate,
  formatSubmissionGateMarkdown,
  issueSatisfiesIdentifier,
  normalizeIdentifier,
  validateSubmissionEvidence,
};
