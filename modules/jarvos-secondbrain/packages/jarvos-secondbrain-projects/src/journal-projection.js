'use strict';

const crypto = require('node:crypto');

const JOURNAL_PROJECTION_CONTRACT = 'jarvos.project-journal-projection/v1';
const PROJECTS_SECTION_HEADING = '## 🚀 Projects';

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

function acceptedActivity(activity) {
  return isPlainObject(activity) && (activity.accepted === true || activity.trust === 'verified');
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

function touchedProjectIds({ activities = [], projects = [], date, timeZone = 'UTC' } = {}) {
  const targetDate = requiredString(date, 'projection date');
  const recordsById = Object.fromEntries(projects.filter((record) => record && record.id).map((record) => [record.id, record]));
  const touched = new Set();
  for (const activity of activities) {
    if (!acceptedActivity(activity) || !activity.canonicalId || localDate(activity.occurredAt, timeZone) !== targetDate) continue;
    const record = recordsById[activity.canonicalId];
    const projectId = record ? projectIdForRecord(record, recordsById) : (String(activity.canonicalId).startsWith('prj_') ? activity.canonicalId : null);
    if (projectId) touched.add(projectId);
  }
  return [...touched].sort();
}

function projectLines({ projects = [], activities = [], date, timeZone = 'UTC', providerState = 'fresh', maxItems = 25 } = {}) {
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
  const byId = Object.fromEntries(projects.filter((record) => record && record.id).map((record) => [record.id, record]));
  const touchedIds = touchedProjectIds({ activities, projects, date, timeZone });
  const ongoing = new Set(['active', 'paused']);
  const touched = touchedIds.map((id) => byId[id]).filter((record) => record && ongoing.has(String(record.lifecycle || record.status || '').toLowerCase()));
  const lines = touched.slice(0, maxItems).map((record) => `- [[${record.title}]]`);
  if (touched.length > maxItems) lines.push(`- _...and ${touched.length - maxItems} more_`);
  return {
    contract: JOURNAL_PROJECTION_CONTRACT,
    status: lines.length ? 'fresh' : 'fresh-empty',
    preserve: false,
    content: lines.length ? lines.join('\n') : null,
    touchedProjectIds: touched.slice(0, maxItems).map((record) => record.id),
    omissions: [],
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

function buildJournalProjection({ date, timeZone = 'UTC', projects = [], activities = [], activityProviderState = 'fresh', generator = 'projects-v1', maxItems = 25 } = {}) {
  const projection = projectLines({ projects, activities, date, timeZone, providerState: activityProviderState, maxItems });
  return {
    ...projection,
    date: requiredString(date, 'projection date'),
    timeZone: requiredString(timeZone, 'projection timezone'),
    generator: requiredString(generator, 'projection generator'),
    inputDigest: digest({ date, timeZone, projects, activities, activityProviderState }),
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
    coverageWatermark,
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
  applyJournalProjection,
  buildJournalProjection,
  digest,
  localDate,
  projectIdForRecord,
  projectLines,
  replaceProjectsSection,
  sectionBounds,
  touchedProjectIds,
};
