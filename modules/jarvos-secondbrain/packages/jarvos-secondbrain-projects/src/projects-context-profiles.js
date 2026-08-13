'use strict';

const { localDate: journalLocalDate } = require('./journal-projection');

const PROFILE_CONTRACT = 'jarvos.projects-query-profile/v1';
const PROFILE_REVISION = 'projects-profiles-1';
const PROFILE_NAMES = Object.freeze(['orientation', 'recent-activity']);

const PROFILE_LIMITS = Object.freeze({
  orientation: Object.freeze({ maxItems: 24, maxBytes: 16_000, maxProviderAgeSeconds: 3_600 }),
  'recent-activity': Object.freeze({ maxItems: 100, maxBytes: 24_000, maxProviderAgeSeconds: 86_400 }),
});

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function requiredString(value, field) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${field} must be a non-empty string`);
  return value.trim();
}

function canonicalDate(value, field = 'date') {
  const normalized = requiredString(value, field);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) throw new TypeError(`${field} must be YYYY-MM-DD`);
  const parsed = Date.parse(`${normalized}T00:00:00.000Z`);
  if (Number.isNaN(parsed) || new Date(parsed).toISOString().slice(0, 10) !== normalized) throw new TypeError(`${field} is not a calendar date`);
  return normalized;
}

function normalizeScope(scope, { required = true } = {}) {
  if (!isPlainObject(scope)) {
    if (!required) return null;
    throw new TypeError('profile scope is required');
  }
  const allowedKeys = new Set(['projectIds', 'outcomeIds', 'includeDescendants']);
  if (Object.keys(scope).some((key) => !allowedKeys.has(key))) throw new TypeError('profile scope has unsupported fields');
  const projectIds = Array.isArray(scope.projectIds) ? scope.projectIds : [];
  const outcomeIds = Array.isArray(scope.outcomeIds) ? scope.outcomeIds : [];
  if (projectIds.some((id) => typeof id !== 'string' || !/^prj_\d{6,}$/.test(id))
    || outcomeIds.some((id) => typeof id !== 'string' || !/^out_\d{6,}$/.test(id))) {
    throw new TypeError('profile scope contains a non-canonical ID');
  }
  if (new Set([...projectIds, ...outcomeIds]).size !== projectIds.length + outcomeIds.length) throw new TypeError('profile scope contains duplicate IDs');
  return {
    projectIds: [...projectIds].sort(),
    outcomeIds: [...outcomeIds].sort(),
    includeDescendants: scope.includeDescendants === true,
  };
}

function localParts(instant, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(instant);
  return Object.fromEntries(parts.map((part) => [part.type, part.value]));
}

function localDate(instant, timeZone) {
  const parts = localParts(instant, timeZone);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function shiftDate(date, days) {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function zonedMidnight(date, timeZone) {
  const target = Date.parse(`${date}T00:00:00.000Z`);
  let guess = target;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const parts = localParts(new Date(guess), timeZone);
    const observed = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second));
    const delta = target - observed;
    if (delta === 0) return new Date(guess);
    guess += delta;
  }
  return new Date(guess);
}

function normalizeTimeZone(timeZone) {
  const value = requiredString(timeZone || 'UTC', 'timeZone');
  try { new Intl.DateTimeFormat('en-US', { timeZone: value }).format(); } catch { throw new TypeError('timeZone is invalid'); }
  return value;
}

function resolveQueryProfile(name, {
  scope,
  now = new Date(),
  timeZone = 'UTC',
  date,
  from,
  to,
  authorizedScope = false,
} = {}) {
  const profile = requiredString(name, 'profile');
  if (!PROFILE_NAMES.includes(profile)) throw new TypeError(`unknown Projects query profile: ${profile}`);
  const normalizedScope = normalizeScope(scope, { required: !authorizedScope });
  if (!authorizedScope && normalizedScope && normalizedScope.projectIds.length + normalizedScope.outcomeIds.length === 0) {
    throw new TypeError('profile scope must identify a project or outcome');
  }
  const effectiveScope = normalizedScope || { projectIds: [], outcomeIds: [], includeDescendants: true };
  const limits = clone(PROFILE_LIMITS[profile]);
  const query = {
    scope: effectiveScope,
    include: profile === 'orientation'
      ? ['hierarchy', 'activity', 'currentWork', 'attention']
      : ['hierarchy', 'activity'],
    limits,
  };
  const result = {
    contract: PROFILE_CONTRACT,
    revision: PROFILE_REVISION,
    name: profile,
    query,
    scopeOrigin: authorizedScope ? 'host-authorized' : 'caller-authorized',
    activityWindow: null,
  };
  if (profile === 'recent-activity') {
    const instant = now instanceof Date ? now : new Date(now);
    if (Number.isNaN(instant.getTime())) throw new TypeError('now is invalid');
    const zone = normalizeTimeZone(timeZone);
    const localToday = journalLocalDate(instant, zone);
    const selectedDate = canonicalDate(date || shiftDate(localToday, -1), 'date');
    const start = from ? new Date(requiredString(from, 'from')) : zonedMidnight(selectedDate, zone);
    const end = to ? new Date(requiredString(to, 'to')) : zonedMidnight(shiftDate(selectedDate, 1), zone);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start >= end) throw new TypeError('activity window is invalid');
    result.activityWindow = {
      from: start.toISOString(),
      to: end.toISOString(),
      localDate: selectedDate,
      timeZone: zone,
    };
  }
  return result;
}

function validateQueryProfile(profile) {
  try {
    if (!isPlainObject(profile) || profile.contract !== PROFILE_CONTRACT || profile.revision !== PROFILE_REVISION) throw new TypeError('invalid Projects query profile');
    const resolved = resolveQueryProfile(profile.name, {
      scope: profile.query?.scope,
      authorizedScope: profile.scopeOrigin === 'host-authorized',
      date: profile.activityWindow?.localDate,
      timeZone: profile.activityWindow?.timeZone,
      from: profile.activityWindow?.from,
      to: profile.activityWindow?.to,
    });
    if (JSON.stringify(resolved.query) !== JSON.stringify(profile.query) || JSON.stringify(resolved.activityWindow) !== JSON.stringify(profile.activityWindow)) throw new TypeError('Projects query profile contents do not match its definition');
    return { ok: true, profile: resolved };
  } catch (error) {
    return { ok: false, reason: error.message };
  }
}

module.exports = {
  PROFILE_CONTRACT,
  PROFILE_LIMITS,
  PROFILE_NAMES,
  PROFILE_REVISION,
  localDate: journalLocalDate,
  resolveQueryProfile,
  validateQueryProfile,
};
