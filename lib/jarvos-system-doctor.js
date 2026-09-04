'use strict';

const REPORT_SCHEMA = 'jarvos-system-doctor-report/v1';

const STATUS_ICON = Object.freeze({
  healthy: '✅',
  warning: '⚠️',
  'repair needed': '❌',
  'not configured': '◻️',
});

const REASON_EXPLANATION = Object.freeze({
  none: null,
  failed: 'broken; repair the failing check',
  'not-configured': 'not configured yet',
  skipped: 'not verified yet',
  'search-empty': 'reachable, but search returned no results',
  'http-unreachable': 'HTTP endpoint unreachable',
  'runtime-tool-missing': 'runtime search tool not available',
  'module-invalid': 'receipt invalid; republish a trusted snapshot',
  'module-stale': 'receipt stale; refresh the producer snapshot',
  'module-untrusted': 'receipt untrusted; check producer ownership',
  'profile-mismatch': 'snapshot profile does not match doctor profile',
  'component-failed': 'one or more selected components need repair',
  'component-degraded': 'one or more selected components need attention',
});

function componentState(item) {
  if (item?.status === 'fail' || item?.ok === false) return 'repair needed';
  if (item?.status === 'warn') return 'warning';
  if (item?.status === 'skipped') return 'not configured';
  return 'healthy';
}

function coreComponents(report) {
  return (report.results || report.checks || []).map((item) => ({
    id: item.id || item.component,
    label: item.id || item.component,
    section: 'core',
    state: componentState(item),
    reasonClass: item.reasonClass || item.status || (item.ok === false ? 'failed' : 'none'),
    message: item.detail
      ? `${item.message || item.id || item.component} — ${item.detail}`
      : item.message || null,
  }));
}

function moduleState(state) {
  if (state === 'repair needed') return 'repair needed';
  if (state === 'healthy') return 'healthy';
  return 'warning';
}

function optionalComponents(modules = []) {
  const system = modules.find((module) => module.id === 'system');
  if (!system) return [];
  if (!Array.isArray(system.components)) {
    return [{
      id: 'module.system',
      label: 'System health receipt',
      section: 'optional',
      state: moduleState(system.state),
      reasonClass: system.reasonClass,
      message: null,
    }];
  }
  return system.components.map((component) => ({
    id: component.id,
    label: component.label,
    section: component.id.startsWith('memory.') ? 'memory' : 'optional',
    state: component.state,
    reasonClass: component.reasonClass,
    message: null,
  }));
}

function buildSystemDoctorReceipt(report) {
  const profile = typeof report.profile === 'string'
    ? { id: report.profile, title: report.profile }
    : { id: report.profile.id, title: report.profile.title };
  const components = [...coreComponents(report), ...optionalComponents(report.modules)];
  let status = 'healthy';
  if (report.ok === false) {
    status = components.some((component) => component.state === 'repair needed')
      ? 'repair needed'
      : 'needs your attention';
  }
  return {
    schema: REPORT_SCHEMA,
    profile,
    workspace: report.workspace,
    status,
    ok: report.ok !== false && status === 'healthy',
    components,
  };
}

function attachSystemDoctorReceipt(report) {
  return { ...report, systemDoctor: buildSystemDoctorReceipt(report) };
}

function explanationFor(component) {
  if (typeof component.message === 'string' && component.message.trim()) {
    return component.message.trim();
  }

  const reason = component.reasonClass || 'none';
  if (Object.prototype.hasOwnProperty.call(REASON_EXPLANATION, reason) && REASON_EXPLANATION[reason]) {
    return REASON_EXPLANATION[reason];
  }

  if (component.state === 'healthy') return null;
  if (component.state === 'not configured') return 'not configured yet';
  if (component.state === 'warning') {
    return reason && reason !== 'none'
      ? `unverified or degraded (${reason})`
      : 'unverified or degraded';
  }
  if (component.state === 'repair needed') {
    return reason && reason !== 'none'
      ? `broken (${reason}); repair before trusting READY`
      : 'broken; repair before trusting READY';
  }
  return null;
}

function renderComponentLine(component) {
  const icon = STATUS_ICON[component.state] || '⚠️';
  const explanation = explanationFor(component);
  // Exactly one status icon and a concise label/explanation.
  // No PASS/FAIL tokens and no repeated state words.
  return explanation ? `${icon} ${component.label} — ${explanation}` : `${icon} ${component.label}`;
}

function renderSystemDoctor(report, { legacyText = null } = {}) {
  const receipt = report.systemDoctor || buildSystemDoctorReceipt(report);
  const lines = legacyText === null
    ? [`jarvOS System Doctor — ${receipt.profile.title}`, `Workspace: ${receipt.workspace}`, '']
    : [legacyText.trimEnd(), ''];

  for (const component of receipt.components) {
    lines.push(renderComponentLine(component));
  }

  // No "Selected optional components" heading and no redundant READY aggregate line.
  // Authoritative readiness remains on receipt.ok / receipt.status for JSON consumers.
  return `${lines.join('\n').trimEnd()}\n`;
}

module.exports = {
  REPORT_SCHEMA,
  STATUS_ICON,
  attachSystemDoctorReceipt,
  buildSystemDoctorReceipt,
  explanationFor,
  renderComponentLine,
  renderSystemDoctor,
};
