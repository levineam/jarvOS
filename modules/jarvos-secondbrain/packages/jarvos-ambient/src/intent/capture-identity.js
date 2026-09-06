'use strict';

const { createHash } = require('node:crypto');
const { primaryText } = require('./keyword-capture-router');
const { buildSkillInvocations } = require('../routing');

function exactObject(value, required, optional = []) {
  return value && Object.getPrototypeOf(value) === Object.prototype
    && required.every((key) => Object.hasOwn(value, key))
    && Object.keys(value).every((key) => required.includes(key) || optional.includes(key));
}

function validateCaptureIdentity(value) {
  const fields = ['namespace', 'id', 'revision'];
  const validRef = (ref, optional = []) => exactObject(ref, fields, optional)
    && fields.every((key) => typeof ref[key] === 'string' && ref[key].trim()
      && ref[key].length <= 512 && !/[\u0000-\u001f\u007f]/.test(ref[key]));
  if (!validRef(value, ['relation'])) throw new Error('Invalid captureIdentity namespace, id or revision');
  if (Object.hasOwn(value, 'relation')) {
    const relation = value.relation;
    if (!exactObject(relation, ['kind', 'target']) || !['corrects', 'withdraws'].includes(relation.kind)
      || !validRef(relation.target)) throw new Error('Invalid captureIdentity relation');
    if (fields.every((key) => value[key] === relation.target[key])) throw new Error('captureIdentity cannot target the same source revision');
  }
  return value;
}

// JSON semantics, recursively sorted object keys; array order and string bytes
// are meaningful. Non-JSON values are never silently erased from equality.
function canonicalJson(value) {
  const visit = (entry) => {
    if (entry === null || typeof entry === 'string' || typeof entry === 'boolean') return entry;
    if (typeof entry === 'number' && Number.isFinite(entry)) return entry;
    if (Array.isArray(entry)) return entry.map(visit);
    if (entry && Object.getPrototypeOf(entry) === Object.prototype) {
      return Object.fromEntries(Object.keys(entry).sort().filter((key) => entry[key] !== undefined)
        .map((key) => [key, visit(entry[key])]));
    }
    throw new Error('Capture identity request must contain only JSON values');
  };
  return JSON.stringify(visit(value));
}

const digest = (value) => createHash('sha256').update(canonicalJson(value)).digest('hex');

function projectNoteTitle(plan, noteTitle, frontmatter) {
  const projected = { ...plan, noteTitle,
    journalLine: plan.journalLine?.replace(`[[${plan.noteTitle}]]`, () => `[[${noteTitle}]]`) };
  if (Array.isArray(plan.actions)) {
    projected.actions = plan.actions.map((action) => {
      if (action.kind === 'note' && action.input?.title === plan.noteTitle) return {
        ...action, input: { ...action.input, title: noteTitle, ...(frontmatter ? { frontmatter } : {}) } };
      if (action.kind === 'journal' && action.input?.line === plan.journalLine) return {
        ...action, input: { ...action.input, line: projected.journalLine } };
      return action;
    });
    projected.skillInvocations = buildSkillInvocations(projected);
  }
  return projected;
}

function prepareIdentifiedCapture(capture, plan) {
  if (capture.captureIdentity === undefined) return { capture, plan };
  const identity = validateCaptureIdentity(capture.captureIdentity);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(capture.date || '')
    || new Date(`${capture.date}T00:00:00Z`).toISOString().slice(0, 10) !== capture.date) {
    throw new Error('captureIdentity requires an explicit valid capture date');
  }
  if (!plan.createNote || plan.ignored) throw new Error('captureIdentity requires an eligible durable note route');
  if (!String(capture.title || '').trim() && !primaryText(capture)) throw new Error('captureIdentity requires a caller-supplied title or text');
  const frontmatter = { ...(capture.frontmatter || {}) };
  // This field has always been assigned by the note writer, not the caller.
  delete frontmatter.jarvos_note_id;
  const canonicalCapture = { ...capture, frontmatter };
  // Only storage effects belong to this operation. Rich routing plans also
  // carry duplicated captures/actions (including ignored caller note IDs).
  const storagePlan = Object.fromEntries(['date', 'createNote', 'noteTitle', 'noteContent',
    'noteFrontmatter', 'journalSection', 'journalLine'].map((key) => [key, plan[key]]));
  const requestHash = digest({ capture: canonicalCapture, plan: storagePlan });
  const identityHash = digest({ namespace: identity.namespace, id: identity.id, revision: identity.revision });
  // Forty Unicode characters leave room for the digest under common 255-byte
  // filename limits, including four-byte characters, without splitting pairs.
  const noteTitle = `${Array.from(String(plan.noteTitle)).slice(0, 40).join('')} -- ${identityHash}`;
  const identifiedPlan = {
    ...plan,
    noteFrontmatter: {
      ...plan.noteFrontmatter,
      capture_identity: canonicalJson(identity),
      capture_provenance: canonicalJson({ source: capture.source, actor: capture.actor,
        origin: capture.origin, evidence: capture.evidence, captureMode: capture.captureMode,
        privacyTier: capture.privacyTier, date: capture.date }),
    },
  };
  return { capture: canonicalCapture,
    plan: projectNoteTitle(identifiedPlan, noteTitle, { ...frontmatter, ...identifiedPlan.noteFrontmatter }),
    requestHash, intentId: `capture:${identityHash}` };
}

module.exports = { canonicalJson, prepareIdentifiedCapture, projectNoteTitle, validateCaptureIdentity };
