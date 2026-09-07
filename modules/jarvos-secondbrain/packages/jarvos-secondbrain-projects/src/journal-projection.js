'use strict';

const crypto = require('node:crypto');

const JOURNAL_PROJECTION_CONTRACT = 'jarvos.project-journal-projection/v1';
const PROJECTS_SECTION_HEADING = '## 🚀 Projects';
const BLOCKED_DISPOSITIONS = new Set(['provisional', 'quarantined', 'rejected', 'superseded', 'not-evaluable']);
const PROJECT_ID_PATTERN = /^prj_[0-9]{6,}$/;

function isPlainObject(value) { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }
function requiredString(value, field) { if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${field} must be a non-empty string`); return value.trim(); }
function clone(value) { return JSON.parse(JSON.stringify(value)); }
function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (isPlainObject(value)) return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  return value;
}
function digest(value) { return crypto.createHash('sha256').update(JSON.stringify(stableValue(value))).digest('hex'); }

function localDate(value, timeZone = 'UTC') {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function activityPayload(activity) {
  if (!isPlainObject(activity)) return null;
  if (!isPlainObject(activity.receipt)) return activity;
  // ActivityStore returns an envelope while the Journal reader may return the
  // admitted receipt directly.  Keep envelope metadata (notably the
  // admission-time root) while using receipt fields as the activity identity.
  return { ...activity.receipt, ...activity };
}

function activityDisposition(activity) {
  const value = activityPayload(activity) || {};
  const candidates = [
    value.disposition,
    value.status,
    value.inferenceDisposition,
    value.candidateDisposition,
    value.inference && value.inference.disposition,
    value.candidate && value.candidate.disposition,
    value.inferenceDecision && value.inferenceDecision.disposition,
    value.decision && value.decision.disposition,
    value.admission && value.admission.disposition,
  ];
  const selected = candidates.find((candidate) => typeof candidate === 'string' && candidate.trim());
  return selected ? selected.trim().toLowerCase() : null;
}

function activityIdentity(activity, fallback = 'unknown') {
  const value = activityPayload(activity) || {};
  return String(value.eventId || value.id || value.canonicalId || fallback);
}

function isContextRead(activity) {
  const value = activityPayload(activity);
  return Boolean(value && (value.kind === 'context-read' || value.category === 'context-read'));
}

function acceptedActivity(activity) {
  const value = activityPayload(activity);
  if (!value || isContextRead(value) || !(value.accepted === true || value.trust === 'verified')) return false;
  return !BLOCKED_DISPOSITIONS.has(activityDisposition(value));
}

function projectIdForRecord(record, recordsById) {
  let current = record;
  const visited = new Set();
  while (current) {
    if (visited.has(current.id)) return null;
    visited.add(current.id);
    if (current.kind === 'project') return current.id;
    current = current.parentId ? recordsById[current.parentId] : null;
  }
  return null;
}

function canonicalProjectId(value) {
  return typeof value === 'string' && PROJECT_ID_PATTERN.test(value) ? value : null;
}

function admissionRootProjectId(activity) {
  const value = activityPayload(activity) || {};
  const pinned = isPlainObject(value.canonicalAtAdmission)
    ? canonicalProjectId(value.canonicalAtAdmission.rootProjectId)
    : null;
  if (pinned) return pinned;
  // A direct Project activity is already rooted by its canonical identity.
  return canonicalProjectId(value.canonicalId);
}

function projectIdForActivity(activity, recordsById) {
  const value = activityPayload(activity) || {};
  const pinned = admissionRootProjectId(value);
  if (pinned) return pinned;

  // An Outcome without an admission-time root is not safe to resolve through
  // today's hierarchy: a later reparent would rewrite historical navigation.
  // Keep direct Project receipts usable, but fail closed for unpinned children.
  const record = recordsById[value.canonicalId];
  return record && record.kind === 'project' ? record.id : null;
}

function touchedProjectIds({ activities = [], projects = [], date, timeZone = 'UTC' } = {}) {
  const targetDate = requiredString(date, 'projection date');
  const records = Array.isArray(projects) ? projects : [];
  const recordsById = Object.fromEntries(records.filter((record) => record && record.id).map((record) => [record.id, record]));
  const touched = [];
  const seen = new Set();
  for (const activity of Array.isArray(activities) ? activities : []) {
    const value = activityPayload(activity);
    if (!acceptedActivity(value) || !value.canonicalId || localDate(value.occurredAt, timeZone) !== targetDate) continue;
    const projectId = projectIdForActivity(value, recordsById);
    if (projectId && !seen.has(projectId)) {
      seen.add(projectId);
      touched.push(projectId);
    }
  }
  return touched;
}

function mappingTarget(mapping) {
  if (typeof mapping === 'string') return mapping.trim();
  if (!isPlainObject(mapping)) return null;
  if (BLOCKED_DISPOSITIONS.has(String(mapping.status || mapping.disposition || '').trim().toLowerCase())) return null;
  return typeof mapping.target === 'string' && mapping.target.trim() ? mapping.target.trim() : null;
}

function mappingId(mapping) {
  if (!isPlainObject(mapping)) return null;
  return mapping.projectId || null;
}

function normalizeNoteMappings(noteMappings) {
  if (noteMappings instanceof Map) {
    return new Map([...noteMappings.entries()]
      .map(([id, mapping]) => [id, mappingTarget(mapping)])
      .filter(([id, target]) => canonicalProjectId(id) && target));
  }
  if (Array.isArray(noteMappings)) {
    return new Map(noteMappings
      .map((mapping) => [mappingId(mapping), mappingTarget(mapping)])
      .filter(([id, target]) => canonicalProjectId(id) && target));
  }
  if (isPlainObject(noteMappings)) {
    return new Map(Object.entries(noteMappings)
      .map(([id, mapping]) => [id, mappingTarget(mapping)])
      .filter(([id, target]) => canonicalProjectId(id) && target));
  }
  return new Map();
}

function noteMappingsSnapshot(noteMappings) {
  return [...normalizeNoteMappings(noteMappings).entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([id, target]) => ({ projectId: id, target }));
}

function normalizeLinkTarget(target) {
  const value = String(target || '').trim();
  if (!value) return null;
  const wrapped = value.match(/^\[\[([\s\S]+)\]\]$/);
  const unwrapped = (wrapped ? wrapped[1] : value).trim();
  if (!unwrapped || /[\r\n]/.test(unwrapped)) return null;
  return unwrapped;
}

function linkTargetBasename(target) {
  const path = String(target || '').split('#', 1)[0].replace(/\/+$/, '');
  return path.split('/').pop() || null;
}

function projectLink({ target, title }) {
  return title && linkTargetBasename(target) !== title
    ? `[[${target}|${title}]]`
    : `[[${target}]]`;
}

function activityOmissions({ activities = [], projects = [], date, timeZone = 'UTC' } = {}) {
  const targetDate = requiredString(date, 'projection date');
  const recordsById = Object.fromEntries((Array.isArray(projects) ? projects : [])
    .filter((record) => record && record.id)
    .map((record) => [record.id, record]));
  const omissions = [];
  for (const [index, activity] of (Array.isArray(activities) ? activities : []).entries()) {
    const value = activityPayload(activity);
    const identity = activityIdentity(value, index);
    if (!value) {
      omissions.push(`activity-invalid:${identity}`);
      continue;
    }
    const occurredDate = localDate(value.occurredAt, timeZone);
    if (!occurredDate || occurredDate !== targetDate) continue;
    // A context read is intentionally not an activity event. It is an
    // ordinary read-path observation, not evidence that Andrew worked on a
    // Project, so it should not degrade an otherwise healthy activity feed.
    if (isContextRead(value)) continue;
    if (!(value.accepted === true || value.trust === 'verified')) {
      omissions.push(`activity-untrusted:${identity}`);
      continue;
    }
    const disposition = activityDisposition(value);
    if (BLOCKED_DISPOSITIONS.has(disposition)) {
      omissions.push(`activity-${disposition}:${identity}`);
      continue;
    }
    if (!value.canonicalId) continue;
    if (!projectIdForActivity(value, recordsById)) omissions.push(`activity-unresolved:${identity}`);
  }
  return [...new Set(omissions)];
}

function projectLines({
  projects = [],
  activities = [],
  date,
  timeZone = 'UTC',
  providerState = 'fresh',
  maxItems = 25,
  noteMappings,
  canonicalNoteMappings,
} = {}) {
  const state = requiredString(providerState, 'activity providerState');
  if (!['fresh', 'healthy-empty'].includes(state)) {
    return {
      contract: JOURNAL_PROJECTION_CONTRACT,
      status: 'degraded',
      preserve: true,
      content: null,
      touchedProjectIds: [],
      omissions: [`activity-provider:${state}`],
    };
  }
  const records = Array.isArray(projects) ? projects : [];
  const byId = Object.fromEntries(records.filter((record) => record && record.id).map((record) => [record.id, record]));
  const touchedIds = touchedProjectIds({ activities, projects: records, date, timeZone });
  const mappings = normalizeNoteMappings(noteMappings === undefined ? canonicalNoteMappings : noteMappings);
  const omissions = activityOmissions({ activities, projects: records, date, timeZone });
  const mapped = [];
  for (const id of touchedIds) {
    const target = normalizeLinkTarget(mappings.get(id));
    if (!target) {
      omissions.push(`canonical-note-mapping:${id}`);
      continue;
    }
    mapped.push({ id, target, title: byId[id]?.title });
  }
  // Targets, rather than Project IDs, are the navigation identity here. A
  // canonical Project can retain multiple legacy mappings to one note; render
  // that note once, keeping the first stable Project-ID occurrence and its
  // canonical title as the display alias.
  const seenTargets = new Set();
  const uniqueMapped = mapped.filter(({ target }) => {
    if (seenTargets.has(target)) return false;
    seenTargets.add(target);
    return true;
  });
  const limited = uniqueMapped.slice(0, maxItems);
  const lines = limited.map(projectLink).map((link) => `- ${link}`);
  if (uniqueMapped.length > maxItems) lines.push(`- _...and ${uniqueMapped.length - maxItems} more_`);
  const uniqueOmissions = [...new Set(omissions)].sort();
  const preserve = uniqueOmissions.length > 0;
  return {
    contract: JOURNAL_PROJECTION_CONTRACT,
    status: preserve ? 'degraded' : (lines.length ? 'fresh' : 'fresh-empty'),
    preserve,
    content: lines.length ? lines.join('\n') : null,
    touchedProjectIds: touchedIds,
    mappedProjectIds: limited.map(({ id }) => id),
    omissions: uniqueOmissions,
  };
}

function sectionBounds(markdown, heading = PROJECTS_SECTION_HEADING) {
  const text = String(markdown || '').replace(/\r\n/g, '\n');
  const lines = text.split('\n');
  const start = lines.findIndex((line) => line.trim() === heading);
  if (start < 0) return { lines, start: -1, end: -1 };
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^##\s+/.test(lines[index])) { end = index; break; }
  }
  return { lines, start, end };
}

function replaceProjectsSection(markdown, content, { heading = PROJECTS_SECTION_HEADING } = {}) {
  const bounds = sectionBounds(markdown, heading);
  if (bounds.start < 0) {
    if (content === null) return String(markdown || '');
    const base = String(markdown || '').replace(/\s*$/, '');
    return `${base}\n\n${heading}\n${content}\n`;
  }
  const replacement = content === null ? [] : [heading, content];
  const next = [...bounds.lines.slice(0, bounds.start), ...replacement, ...bounds.lines.slice(bounds.end)];
  return `${next.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\s+$/, '')}\n`;
}

function buildJournalProjection({
  date,
  timeZone = 'UTC',
  projects = [],
  activities = [],
  activityProviderState = 'fresh',
  coverageWatermark = null,
  generator = 'projects-v1',
  maxItems = 25,
  noteMappings,
  canonicalNoteMappings,
} = {}) {
  const mappings = noteMappings === undefined ? canonicalNoteMappings : noteMappings;
  const projection = projectLines({
    projects,
    activities,
    date,
    timeZone,
    providerState: activityProviderState,
    maxItems,
    noteMappings: mappings,
  });
  return {
    ...projection,
    date: requiredString(date, 'projection date'),
    timeZone: requiredString(timeZone, 'projection timezone'),
    generator: requiredString(generator, 'projection generator'),
    coverageWatermark: coverageWatermark == null ? null : requiredString(coverageWatermark, 'coverage watermark'),
    inputDigest: digest({ date, timeZone, projects, activities, activityProviderState, coverageWatermark, noteMappings: noteMappingsSnapshot(mappings) }),
  };
}

function applyJournalProjection({ content, expectedRevision, projection, write, coverageWatermark = null, now = new Date().toISOString() } = {}) {
  if (!projection || projection.contract !== JOURNAL_PROJECTION_CONTRACT) return { status: 'unavailable', reason: 'invalid-projection' };
  const current = String(content || '');
  const priorRevision = digest(current);
  if (expectedRevision && expectedRevision !== priorRevision) return { status: 'conflict', reason: 'expected-revision-mismatch', priorRevision };
  if (projection.preserve) return { status: 'degraded', preserve: true, priorRevision, omissions: [...(projection.omissions || [])] };
  const nextContent = replaceProjectsSection(current, projection.content);
  const resultRevision = digest(nextContent);
  const manifest = {
    contract: JOURNAL_PROJECTION_CONTRACT,
    generator: projection.generator,
    date: projection.date,
    timeZone: projection.timeZone,
    coverageWatermark: projection.coverageWatermark || coverageWatermark,
    inputDigest: projection.inputDigest,
    priorRevision,
    resultRevision,
    observedAt: now,
    status: 'planned',
  };
  if (nextContent === current) return { status: 'already_satisfied', content: current, manifest: { ...manifest, status: 'already_satisfied' } };
  if (typeof write !== 'function') return { status: 'planned', content: nextContent, manifest };
  const receipt = write({ expectedContent: current, nextContent, manifest });
  const status = receipt?.status || 'unavailable';
  return { status, content: nextContent, manifest: { ...manifest, status }, receipt };
}

module.exports = {
  JOURNAL_PROJECTION_CONTRACT,
  PROJECTS_SECTION_HEADING,
  acceptedActivity,
  activityOmissions,
  admissionRootProjectId,
  applyJournalProjection,
  buildJournalProjection,
  canonicalProjectId,
  digest,
  isContextRead,
  localDate,
  normalizeNoteMappings,
  noteMappingsSnapshot,
  projectIdForActivity,
  projectIdForRecord,
  projectLines,
  replaceProjectsSection,
  sectionBounds,
  touchedProjectIds,
};
