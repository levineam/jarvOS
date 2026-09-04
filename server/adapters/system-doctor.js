'use strict';

/**
 * System Doctor receipt consumer for jarvOS Desktop.
 *
 * Consumes jarvos-system-doctor-report/v1 after jarvOS#280. Does not probe
 * providers, schedule repairs, deliver notifications, or reinterpret readiness
 * policy — it loads a published public receipt or composes one from public
 * jarvos doctor checks + owner-published health-module snapshots via the
 * vendored public contract.
 *
 * Presentation matches the compact scoreboard: one icon per row, eleven-row
 * Memory order (facts/v2), equal SearXNG visibility among Services, concise
 * degraded guidance, and no repeated PASS/FAIL/final-status wording.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  loadHealthModules,
  MEMORY_COMPONENTS,
  SYSTEM_FACTS_VERSION,
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
  'module-invalid': 'Receipt is invalid. Republish it.',
  'module-stale': 'Receipt is stale. Refresh it.',
  'module-untrusted': 'Receipt is untrusted. Publish a trusted receipt.',
});

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
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
    ? 'Fix it, then rerun Doctor.'
    : 'Verify it, then rerun Doctor.';
  return `${detail} ${action}`;
}

function readJsonFile(filePath, fsImpl = fs) {
  try {
    return { ok: true, value: JSON.parse(fsImpl.readFileSync(filePath, 'utf8')) };
  } catch (error) {
    return { ok: false, error: error.code || error.message };
  }
}

function doctorConfig(cfg = {}) {
  const sd = cfg.systemDoctor && typeof cfg.systemDoctor === 'object' ? cfg.systemDoctor : {};
  const workspace = sd.workspace || cfg.workspace || null;
  return {
    workspace,
    profile: sd.profile || 'local-openclaw',
    jarvosBin: sd.jarvosBin || 'jarvos',
    receiptFile: sd.receiptFile || null,
    doctorTimeoutMs: Number.isFinite(sd.doctorTimeoutMs) ? sd.doctorTimeoutMs : 45_000,
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
  };
}

function validateReceipt(receipt) {
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
    factsVersion: SYSTEM_FACTS_VERSION,
    profile: {
      id: receipt.profile.id,
      title: receipt.profile.title || receipt.profile.id,
    },
    workspace: receipt.workspace,
    status: receipt.status,
    components: [...core, ...optional, ...memory],
    sections: {
      core,
      optional,
      memory,
    },
    memoryOrder: MEMORY_ORDER.slice(),
    source: receipt.source || 'unknown',
    presentation: 'compact-scoreboard',
  };
}

function loadPublishedReceipt(filePath, fsImpl = fs) {
  if (!filePath) return null;
  const raw = readJsonFile(filePath, fsImpl);
  if (!raw.ok) return null;
  // Accept public report schema only — private producer receipts are not rendered.
  if (raw.value?.schema !== REPORT_SCHEMA) return null;
  const checked = validateReceipt({ ...raw.value, source: 'receipt-file' });
  return checked.ok ? checked.receipt : null;
}

function runPublicDoctor({ jarvosBin, workspace, profile, doctorTimeoutMs }) {
  if (!workspace || !jarvosBin) return null;
  try {
    const result = spawnSync(
      jarvosBin,
      ['doctor', '--profile', profile, '--workspace', workspace, '--json'],
      {
        encoding: 'utf8',
        timeout: doctorTimeoutMs,
        env: process.env,
      },
    );
    if (result.error || result.status === null) return null;
    const stdout = String(result.stdout || '').trim();
    if (!stdout) return null;
    const start = stdout.indexOf('{');
    const end = stdout.lastIndexOf('}');
    if (start < 0 || end < start) return null;
    return JSON.parse(stdout.slice(start, end + 1));
  } catch {
    return null;
  }
}

function profileMeta(report, fallbackProfile) {
  if (isPlainObject(report?.profile) && report.profile.id) {
    return {
      id: report.profile.id,
      title: report.profile.title || report.profile.id,
    };
  }
  if (typeof report?.profile === 'string' && report.profile) {
    return { id: report.profile, title: report.profile };
  }
  return { id: fallbackProfile, title: fallbackProfile };
}

function buildFromPublicSources(opts, { fsImpl = fs, doctorRunner = runPublicDoctor } = {}) {
  const { workspace, profile, jarvosBin, doctorTimeoutMs } = opts;
  if (!workspace) {
    return {
      ok: false,
      error: 'systemDoctor.workspace is not configured',
      receipt: null,
    };
  }

  const doctorReport = doctorRunner({ jarvosBin, workspace, profile, doctorTimeoutMs }) || {
    ok: true,
    profile,
    workspace,
    checks: [],
    results: [],
  };

  if (doctorReport.systemDoctor) {
    const checked = validateReceipt({ ...doctorReport.systemDoctor, source: 'jarvos-doctor' });
    if (checked.ok) return { ok: true, receipt: checked.receipt, doctorOk: doctorReport.ok !== false };
  }

  const modules = loadHealthModules({
    workspace,
    profile,
    now: new Date(),
    fsImpl,
  });

  const report = {
    ok: doctorReport.ok !== false,
    profile: profileMeta(doctorReport, profile),
    workspace: doctorReport.workspace || workspace,
    checks: doctorReport.checks || doctorReport.results || [],
    results: doctorReport.results || doctorReport.checks || [],
    modules: modules.modules || [],
  };

  const receipt = buildSystemDoctorReceipt(report);
  const checked = validateReceipt({ ...receipt, source: 'composed-public' });
  if (!checked.ok) return { ok: false, error: checked.error, receipt: null };
  return { ok: true, receipt: checked.receipt, doctorOk: report.ok };
}

function loadReceipt(cfg, deps = {}) {
  const opts = doctorConfig(cfg);
  const fsImpl = deps.fsImpl || fs;
  const doctorRunner = deps.doctorRunner || runPublicDoctor;

  const published = loadPublishedReceipt(opts.receiptFile, fsImpl);
  if (published) return { ok: true, receipt: published };

  return buildFromPublicSources(opts, { fsImpl, doctorRunner });
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
  runPublicDoctor,
  compactRows,
};
