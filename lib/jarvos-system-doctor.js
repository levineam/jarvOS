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
    components,
  };
}

function attachSystemDoctorReceipt(report) {
  return { ...report, systemDoctor: buildSystemDoctorReceipt(report) };
}

function renderSystemDoctor(report, { legacyText = null } = {}) {
  const receipt = report.systemDoctor || buildSystemDoctorReceipt(report);
  const lines = legacyText === null
    ? [`jarvOS System Doctor — ${receipt.profile.title}`, `Workspace: ${receipt.workspace}`, '', 'Core:']
    : [legacyText.trimEnd()];
  const marker = {
    healthy: '✅',
    warning: '⚠️',
    'repair needed': '❌',
    'not configured': '◻️',
  };
  const word = {
    healthy: 'PASS',
    warning: 'WARN',
    'repair needed': 'FAIL',
    'not configured': 'SKIP',
  };
  if (legacyText === null) {
    for (const component of receipt.components) {
      if (component.section !== 'core') continue;
      lines.push(`${marker[component.state]} ${word[component.state]} ${component.label} — ${component.state}${component.message ? ` (${component.message})` : ''}`);
    }
  }
  const selected = receipt.components.filter((component) => component.section !== 'core');
  if (selected.length) {
    lines.push('', 'Selected optional components:');
    for (const component of selected) {
      lines.push(`${marker[component.state]} ${word[component.state]} ${component.label} — ${component.state}`);
    }
  }
  const prefix = legacyText === null ? '' : 'System Doctor: ';
  lines.push('', receipt.status === 'healthy' ? `${prefix}READY` : `${prefix}NOT READY — ${receipt.status}`);
  return lines.join('\n');
}

module.exports = {
  REPORT_SCHEMA,
  attachSystemDoctorReceipt,
  buildSystemDoctorReceipt,
  renderSystemDoctor,
};
