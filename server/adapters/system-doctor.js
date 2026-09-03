'use strict';

/**
 * System Doctor receipt consumer for jarvOS Desktop.
 *
 * Consumes jarvos-system-doctor-report/v1. Does not probe providers, schedule
 * repairs, or reinterpret readiness policy — it loads a published receipt or
 * builds one from public jarvos doctor checks + owner-published health-module
 * snapshots via the vendored public contract.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  loadHealthModules,
  MEMORY_COMPONENTS,
} = require('../vendor/jarvos-doctor-modules');
const {
  REPORT_SCHEMA,
  buildSystemDoctorReceipt,
} = require('../vendor/jarvos-system-doctor');

const MEMORY_ORDER = (MEMORY_COMPONENTS || []).map(([id]) => id);
const COMPONENT_STATES = new Set(['healthy', 'warning', 'repair needed', 'not configured']);
const RECEIPT_STATUSES = new Set(['healthy', 'repair needed', 'needs your attention']);

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
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

  for (const component of receipt.components) {
    if (component.section === 'core') core.push(component);
    else if (component.section === 'memory' || String(component.id).startsWith('memory.')) {
      memoryById.set(component.id, { ...component, section: 'memory' });
    } else optional.push({ ...component, section: component.section || 'optional' });
  }

  // Retain the fixed ten-row Memory order. Missing rows stay absent (selection
  // is the roster); present rows are reordered to the public contract order.
  const memory = [];
  for (const id of MEMORY_ORDER) {
    if (memoryById.has(id)) memory.push(memoryById.get(id));
  }
  // Keep any unexpected memory.* rows after the fixed roster rather than drop.
  for (const [id, component] of memoryById) {
    if (!MEMORY_ORDER.includes(id)) memory.push(component);
  }

  return {
    schema: REPORT_SCHEMA,
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
    // Doctor may print non-JSON warnings; take the last JSON object.
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

  // Prefer a receipt already attached by a current jarvos doctor.
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

/**
 * Load the public System Doctor receipt for Desktop rendering.
 */
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
      profile: { id: 'unavailable', title: 'System Doctor' },
      workspace: '',
      status: 'needs your attention',
      components: [],
      sections: { core: [], optional: [], memory: [] },
      memoryOrder: MEMORY_ORDER.slice(),
      source: 'unavailable',
    },
  };
}

module.exports = {
  REPORT_SCHEMA,
  MEMORY_ORDER,
  doctorConfig,
  validateReceipt,
  normalizeReceipt,
  loadPublishedReceipt,
  buildFromPublicSources,
  loadReceipt,
  emptyUnavailable,
  runPublicDoctor,
};
