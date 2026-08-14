'use strict';

const crypto = require('node:crypto');

const SUBJECT_FIELDS = Object.freeze(['repositoryId', 'checkoutId', 'worktreeId', 'branchId', 'candidateId']);

function canonicalSubjectTuple(input = {}) {
  const tuple = Object.fromEntries(SUBJECT_FIELDS.map((field) => [field, input[field] == null ? null : String(input[field])]));
  if (!SUBJECT_FIELDS.some((field) => tuple[field])) throw new Error('subject identity requires a workspace identity');
  return tuple;
}

function deriveSubjectIdentity(input = {}) {
  const tuple = canonicalSubjectTuple(input);
  return `subject:${crypto.createHash('sha256').update(JSON.stringify(tuple)).digest('hex')}`;
}

module.exports = { SUBJECT_FIELDS, canonicalSubjectTuple, deriveSubjectIdentity };
