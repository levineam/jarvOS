'use strict';

const REPORT_SCHEMA = 'jarvos-system-doctor-report/v1';

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

function moduleState(state, reasonClass) {
  if (state === 'repair needed' || reasonClass === 'module-invalid') return 'repair needed';
  if (state === 'healthy') return 'healthy';
  return 'warning';
}

function optionalComponents(modules = []) {
  const system = modules.find((module) => module.id === 'system');
  const components = [];
  if (system && !Array.isArray(system.components)) {
    components.push({
      id: 'module.system',
      label: 'System health receipt',
      section: 'optional',
      state: moduleState(system.state, system.reasonClass),
      reasonClass: system.reasonClass,
      message: null,
    });
  } else if (system) {
    components.push(...system.components.map((component) => ({
      id: component.id,
      label: component.label,
      section: component.id.startsWith('memory.') ? 'memory' : 'optional',
      state: component.state,
      reasonClass: component.reasonClass,
      message: null,
    })));
  }
  const memoryProjected = components.some((component) => component.section === 'memory');
  for (const module of modules) {
    if (module.id === 'system' || (module.id === 'memory' && memoryProjected)) continue;
    if (!['repair needed', 'needs your attention'].includes(module.state)) continue;
    components.push({
      id: `module.${module.id}`,
      label: module.id === 'memory' ? 'Memory receipt' : 'GBrain continuity',
      section: module.id === 'memory' ? 'memory' : 'optional',
      state: moduleState(module.state, module.reasonClass),
      reasonClass: module.reasonClass,
      message: null,
    });
  }
  return components;
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
    components,
  };
}

function attachSystemDoctorReceipt(report) {
  return { ...report, systemDoctor: buildSystemDoctorReceipt(report) };
}

function sentence(value) {
  if (!value) return '';
  return /[.!?]$/.test(value) ? value : `${value}.`;
}

function humanizeReason(reasonClass) {
  return String(reasonClass || 'unverified').replace(/[.-]+/g, ' ');
}

function componentExplanation(component) {
  const known = {
    'http-unreachable': 'HTTP check failed. Restore access, then rerun Doctor.',
    'search-empty': 'No search results. Run a real search, then rerun Doctor.',
    'runtime-tool-missing': 'Runtime search tool unavailable. Enable it, then rerun Doctor.',
    'profile-mismatch': 'Receipt is for another profile. Publish a matching receipt.',
    'module-invalid': 'Receipt is invalid. Republish it.',
    'module-stale': 'Receipt is stale. Refresh it.',
    'module-untrusted': 'Receipt is untrusted. Publish a trusted receipt.',
  };
  if (known[component.reasonClass]) return known[component.reasonClass];
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

function renderSystemDoctor(report) {
  const receipt = report.systemDoctor || buildSystemDoctorReceipt(report);
  const lines = [`jarvOS System Doctor — ${receipt.profile.title}`, `Workspace: ${receipt.workspace}`];
  const marker = {
    healthy: '✅',
    warning: '⚠️',
    'repair needed': '❌',
    'not configured': '⚠️',
  };
  const sectionLabel = {
    core: 'Core',
    optional: 'Services',
    memory: 'Memory',
  };
  const sections = ['core', 'optional', 'memory']
    .filter((section) => receipt.components.some((component) => component.section === section));
  const showSections = sections.length > 1;
  for (const section of sections) {
    lines.push('');
    if (showSections) lines.push(sectionLabel[section]);
    for (const component of receipt.components.filter((item) => item.section === section)) {
      const explanation = component.state === 'healthy' ? '' : ` — ${componentExplanation(component)}`;
      lines.push(`${marker[component.state]} ${component.label}${explanation}`);
    }
  }
  return lines.join('\n');
}

module.exports = {
  REPORT_SCHEMA,
  attachSystemDoctorReceipt,
  buildSystemDoctorReceipt,
  renderSystemDoctor,
};
