'use strict';

/**
 * System Doctor receipt consumer for jarvOS Desktop.
 *
 * Consumes jarvos-system-doctor-report/v1 after jarvOS#280. Does not probe
 * providers, schedule repairs, deliver notifications, or reinterpret readiness
 * policy — it loads a published public receipt or composes one from public
 * owner-published health-module snapshots via the
 * vendored public contract.
 *
 * Presentation matches the compact scoreboard: one icon per row, eleven-row
 * Memory order (facts/v2), equal SearXNG visibility among Services, concise
 * degraded guidance, and no repeated PASS/FAIL/final-status wording.
 */

const fs = require('fs');
const path = require('path');
const {
  loadHealthModules,
  MEMORY_COMPONENTS,
  SYSTEM_FACTS_VERSION,
  SYSTEM_FACTS_VERSION_V3,
  SYSTEM_FACTS_VERSIONS,
} = require('../vendor/jarvos-doctor-modules');
const {
  REPORT_SCHEMA,
  buildSystemDoctorReceipt,
} = require('../vendor/jarvos-system-doctor');

const MEMORY_ORDER = (MEMORY_COMPONENTS || []).map(([id]) => id);
const MEMORY_LABELS = Object.fromEntries(MEMORY_COMPONENTS || []);
const COMPONENT_STATES = new Set(['healthy', 'warning', 'repair needed', 'not configured']);
const RECEIPT_STATUSES = new Set(['healthy', 'repair needed', 'needs your attention']);

const KNOWN_GUIDANCE = Object.freeze({
  'http-unreachable': 'HTTP check failed. Restore access, then rerun Doctor.',
  'search-empty': 'No search results. Run a real search, then rerun Doctor.',
  'runtime-tool-missing': 'Runtime search tool unavailable. Enable it, then rerun Doctor.',
  'profile-mismatch': 'Receipt is for another profile. Publish a matching receipt.',
  'component-stale': 'This component\'s published evidence is stale. A trusted publisher must refresh it.',
  'module-invalid': 'Published evidence is invalid. A trusted publisher must replace it.',
  'module-stale': 'Published evidence is stale. A trusted publisher must refresh it.',
  'module-untrusted': 'Published evidence is untrusted. A trusted publisher must replace it.',
});

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function validDatePair(observedAt, validUntil, now = new Date()) {
  if (observedAt === null && validUntil === null) return true;
  if (typeof observedAt !== 'string' || typeof validUntil !== 'string') return false;
  const observed = new Date(observedAt);
  const valid = new Date(validUntil);
  return !Number.isNaN(observed.getTime()) && !Number.isNaN(valid.getTime())
    && observed.toISOString() === observedAt && valid.toISOString() === validUntil
    && valid > observed && observed <= now;
}

function sentence(value) {
  if (!value) return '';
  return /[.!?]$/.test(value) ? value : `${value}.`;
}

function humanizeReason(reasonClass) {
  return String(reasonClass || 'unverified').replace(/[.-]+/g, ' ');
}

function componentGuidance(component) {
  if (!component || component.state === 'healthy') return null;
  if (KNOWN_GUIDANCE[component.reasonClass]) return KNOWN_GUIDANCE[component.reasonClass];
  if (component.state === 'not configured') {
    const detail = component.message ? sentence(component.message) : 'Not configured.';
    return `${detail} Configure it when needed.`;
  }
  const detail = sentence(component.message || humanizeReason(component.reasonClass));
  const action = component.state === 'repair needed'
    ? 'See the owner-published evidence before attempting a repair.'
    : 'See the published evidence and owner guidance.';
  return `${detail} ${action}`;
}

function doctorConfig(cfg = {}) {
  const sd = cfg.systemDoctor && typeof cfg.systemDoctor === 'object' ? cfg.systemDoctor : {};
  const workspace = sd.workspace || cfg.workspace || null;
  return {
    workspace,
    profile: sd.profile || 'local-openclaw',
    receiptFile: sd.receiptFile || null,
  };
}

function decorateComponent(component) {
  const id = component.id;
  const label = component.label
    || MEMORY_LABELS[id]
    || id;
  const guidance = componentGuidance({ ...component, label });
  return {
    id,
    label,
    section: component.section,
    state: component.state,
    reasonClass: component.reasonClass || 'none',
    message: component.message || null,
    guidance,
    observedAt: component.observedAt || null,
    validUntil: component.validUntil || null,
    freshness: component.freshness || 'unavailable',
  };
}

function validateReceipt(receipt, now = new Date()) {
  if (!isPlainObject(receipt) || receipt.schema !== REPORT_SCHEMA) {
    return { ok: false, error: 'invalid system doctor receipt schema' };
  }
  if (!isPlainObject(receipt.profile) || typeof receipt.profile.id !== 'string' || !receipt.profile.id) {
    return { ok: false, error: 'receipt.profile.id required' };
  }
  if (typeof receipt.profile.title !== 'string' || !receipt.profile.title) {
    return { ok: false, error: 'receipt.profile.title required' };
  }
  if (typeof receipt.workspace !== 'string' || !receipt.workspace) {
    return { ok: false, error: 'receipt.workspace required' };
  }
  if (!RECEIPT_STATUSES.has(receipt.status)) {
    return { ok: false, error: 'receipt.status invalid' };
  }
  if (!SYSTEM_FACTS_VERSIONS.includes(receipt.factsVersion)) {
    return { ok: false, error: 'receipt.factsVersion unsupported' };
  }
  if (!Array.isArray(receipt.components)) {
    return { ok: false, error: 'receipt.components must be an array' };
  }
  for (const component of receipt.components) {
    if (!isPlainObject(component)) return { ok: false, error: 'component must be an object' };
    if (typeof component.id !== 'string' || !component.id) return { ok: false, error: 'component.id required' };
    if (typeof component.label !== 'string' || !component.label) return { ok: false, error: 'component.label required' };
    if (!['core', 'optional', 'memory'].includes(component.section)) {
      return { ok: false, error: `component.section invalid for ${component.id}` };
    }
    if (!COMPONENT_STATES.has(component.state)) {
      return { ok: false, error: `component.state invalid for ${component.id}` };
    }
    if (receipt.factsVersion === SYSTEM_FACTS_VERSION_V3) {
      if (!Object.hasOwn(component, 'observedAt') || !Object.hasOwn(component, 'validUntil')) {
        return { ok: false, error: `component dates required for ${component.id}` };
      }
      if ((component.observedAt === null) !== (component.validUntil === null)) {
        return { ok: false, error: `component dates incomplete for ${component.id}` };
      }
      if (!validDatePair(component.observedAt, component.validUntil, now)) {
        return { ok: false, error: `component dates invalid for ${component.id}` };
      }
    } else if (component.observedAt != null || component.validUntil != null) {
      return { ok: false, error: `component dates unsupported for ${component.id}` };
    }
  }
  return { ok: true, receipt: normalizeReceipt(receipt) };
}

function normalizeReceipt(receipt) {
  const core = [];
  const optional = [];
  const memoryById = new Map();

  for (const raw of receipt.components) {
    const component = decorateComponent(raw);
    if (component.section === 'core') core.push(component);
    else if (component.section === 'memory' || String(component.id).startsWith('memory.')) {
      memoryById.set(component.id, { ...component, section: 'memory' });
    } else optional.push({ ...component, section: component.section || 'optional' });
  }

  // Retain the fixed eleven-row Memory order (facts/v2). Missing rows stay
  // absent (selection is the roster); present rows are reordered.
  const memory = [];
  for (const id of MEMORY_ORDER) {
    if (memoryById.has(id)) memory.push(memoryById.get(id));
  }
  for (const [id, component] of memoryById) {
    if (!MEMORY_ORDER.includes(id)) memory.push(component);
  }

  return {
    schema: REPORT_SCHEMA,
    factsVersion: receipt.factsVersion,
    profile: {
      id: receipt.profile.id,
      title: receipt.profile.title || receipt.profile.id,
    },
    workspace: receipt.workspace,
    status: receipt.components.some((c) => c.state === 'repair needed') ? 'repair needed'
      : !receipt.components.length || receipt.components.some((c) => c.state !== 'healthy')
        ? 'needs your attention' : receipt.status,
    components: [...core, ...optional, ...memory],
    sections: {
      core,
      optional,
      memory,
    },
    memoryOrder: MEMORY_ORDER.slice(),
    source: receipt.source || 'unknown',
    observations: receipt.observations || [],
    coverage: 'Published observations only; unobserved checks are not verified.',
    presentation: 'compact-scoreboard',
  };
}

function loadPublishedReceipt(filePath, fsImpl = fs, opts = {}, now = new Date()) {
  if (!filePath) return null;
  let fd;
  let raw;
  try {
    const parent = fsImpl.lstatSync(path.dirname(filePath));
    if (!parent.isDirectory() || parent.isSymbolicLink() || (parent.mode & 0o022)
      || (process.getuid && parent.uid !== process.getuid())) return null;
    fd = fsImpl.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const stat = fsImpl.fstatSync(fd);
    if (!stat.isFile() || (stat.mode & 0o077)
      || (process.getuid && stat.uid !== process.getuid())) return null;
    raw = JSON.parse(fsImpl.readFileSync(fd, 'utf8'));
  } catch { return null; }
  finally { if (fd !== undefined) fsImpl.closeSync(fd); }
  // Accept public report schema only — private producer receipts are not rendered.
  if (raw?.schema !== REPORT_SCHEMA || !Array.isArray(raw.components)) return null;
  if (raw.profile?.id !== opts.profile || path.resolve(raw.workspace || '.') !== path.resolve(opts.workspace || '.')) return null;
  const freshness = observation(raw, now);
  if (freshness.freshness !== 'current') return null;
  const factsVersion = raw.factsVersion == null ? SYSTEM_FACTS_VERSION : raw.factsVersion;
  const components = raw.components.map((c) => {
    if (!isPlainObject(c)) return c;
    const dates = observation(c, now);
    return dates.freshness === 'stale'
      ? { ...c, ...dates, state: 'warning', reasonClass: 'component-stale', message: null }
      : { ...c, ...dates };
  });
  const checked = validateReceipt({ ...raw, factsVersion, source: 'receipt-file', observations: [{ id: 'system', ...freshness }], components }, now);
  return checked.ok ? checked.receipt : null;
}

function observation(item, now) {
  const start = Date.parse(item.observedAt);
  const end = Date.parse(item.validUntil);
  const valid = Number.isFinite(start) && Number.isFinite(end) && start <= now.getTime() && end > start;
  return {
    observedAt: Number.isFinite(start) ? new Date(start).toISOString() : null,
    validUntil: Number.isFinite(end) ? new Date(end).toISOString() : null,
    freshness: !valid ? 'unavailable' : end <= now.getTime() ? 'stale' : 'current',
  };
}

function buildFromPublicSources(opts, { fsImpl = fs, now = new Date() } = {}) {
  const { workspace, profile } = opts;
  if (!workspace) {
    return {
      ok: false,
      error: 'systemDoctor.workspace is not configured',
      receipt: null,
    };
  }

  const modules = loadHealthModules({
    workspace,
    profile,
    now,
    fsImpl,
  });

  const report = {
    ok: modules.modules.length > 0 && modules.modules.every((m) => m.state === 'healthy'),
    profile: { id: profile, title: profile },
    workspace,
    checks: [],
    modules: modules.modules || [],
  };

  const receipt = buildSystemDoctorReceipt(report);
  if (!receipt.components.length) return emptyUnavailable('No published system observations are available.');
  receipt.observations = report.modules.map((m) => ({ id: m.id, generation: m.generation || null,
    ...observation(m, now), state: m.state, reasonClass: m.reasonClass }));
  for (const component of receipt.components) {
    Object.assign(component, observation(component, now));
    if (component.freshness === 'stale' && component.state === 'healthy') {
      component.state = 'warning';
      component.reasonClass = 'component-stale';
    }
  }
  const checked = validateReceipt({
    ...receipt,
    factsVersion: receipt.factsVersion || SYSTEM_FACTS_VERSION,
    source: 'published-modules',
  }, now);
  if (!checked.ok) return { ok: false, error: checked.error, receipt: null };
  return { ok: true, receipt: checked.receipt };
}

function loadReceipt(cfg, deps = {}) {
  const opts = doctorConfig(cfg);
  const fsImpl = deps.fsImpl || fs;
  if (opts.receiptFile) {
    const published = loadPublishedReceipt(opts.receiptFile, fsImpl, opts, deps.now || new Date());
    return published ? { ok: true, receipt: published }
      : emptyUnavailable('The configured System receipt is missing, invalid, expired or for another host/profile.');
  }
  return buildFromPublicSources(opts, { ...deps, fsImpl });
}

function emptyUnavailable(message) {
  return {
    ok: false,
    error: message,
    receipt: {
      schema: REPORT_SCHEMA,
      factsVersion: SYSTEM_FACTS_VERSION,
      profile: { id: 'unavailable', title: 'System Doctor' },
      workspace: '',
      status: 'needs your attention',
      components: [],
      sections: { core: [], optional: [], memory: [] },
      memoryOrder: MEMORY_ORDER.slice(),
      source: 'unavailable',
      presentation: 'compact-scoreboard',
    },
  };
}

/** Rendered-behavior proof helper used by tests — mirrors Desktop row copy. */
function compactRows(receipt) {
  if (!receipt) return [];
  const rows = [];
  const sectionLabel = { core: 'Core', optional: 'Services', memory: 'Memory' };
  for (const section of ['core', 'optional', 'memory']) {
    const items = receipt.sections?.[section] || [];
    for (const component of items) {
      rows.push({
        section,
        sectionLabel: sectionLabel[section],
        id: component.id,
        label: component.label,
        state: component.state,
        icon: component.state === 'healthy' ? 'ok' : component.state === 'repair needed' ? 'bad' : 'warn',
        guidance: component.state === 'healthy' ? null : (component.guidance || componentGuidance(component)),
      });
    }
  }
  return rows;
}

module.exports = {
  REPORT_SCHEMA,
  SYSTEM_FACTS_VERSION,
  MEMORY_ORDER,
  MEMORY_LABELS,
  doctorConfig,
  validateReceipt,
  normalizeReceipt,
  componentGuidance,
  loadPublishedReceipt,
  buildFromPublicSources,
  loadReceipt,
  emptyUnavailable,
  compactRows,
};
