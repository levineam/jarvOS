'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const MIN_NODE_MAJOR = 18;
const REQUIRED_WORKSPACE_FILES = [
  'AGENTS.md',
  'BOOTSTRAP.md',
  'HEARTBEAT.md',
  'MEMORY.md',
  'USER.md',
  'ONTOLOGY.md',
  'SOUL.md',
  'TOOLS.md',
  'jarvos.config.json',
];

function expandHome(value) {
  if (!value) return value;
  if (value === '~') return os.homedir();
  if (value.startsWith('~/')) return path.join(os.homedir(), value.slice(2));
  return value;
}

function parseArgs(argv = []) {
  const args = {
    command: null,
    positionals: [],
    options: {},
    passthrough: [],
    help: false,
  };

  const copy = argv.slice();
  args.command = copy.shift() || 'help';
  if (args.command === '--help' || args.command === '-h') {
    args.command = 'help';
    args.help = true;
  }
  for (let index = 0; index < copy.length; index += 1) {
    const arg = copy[index];
    if (arg === '--help' || arg === '-h') {
      args.help = true;
      args.passthrough.push(arg);
    } else if (arg === '--profile' && copy[index + 1]) {
      args.options.profile = copy[++index];
    } else if (arg.startsWith('--profile=')) {
      args.options.profile = arg.slice('--profile='.length);
    } else if (arg === '--workspace' && copy[index + 1]) {
      args.options.workspace = copy[++index];
    } else if (arg.startsWith('--workspace=')) {
      args.options.workspace = arg.slice('--workspace='.length);
    } else if (arg === '--config' && copy[index + 1]) {
      args.options.config = copy[++index];
    } else if (arg.startsWith('--config=')) {
      args.options.config = arg.slice('--config='.length);
    } else if (arg === '--json') {
      args.options.json = true;
    } else if (arg.startsWith('-')) {
      args.passthrough.push(arg);
    } else {
      args.positionals.push(arg);
      args.passthrough.push(arg);
    }
  }

  return args;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function profilePath(profileId) {
  return path.join(ROOT, 'profiles', `${profileId}.json`);
}

function loadProfile(profileId = 'minimal') {
  if (!/^[a-z0-9-]+$/.test(profileId)) {
    throw new Error(`Invalid profile id: ${profileId}`);
  }
  const filePath = profilePath(profileId);
  if (!fs.existsSync(filePath)) {
    throw new Error(`Unknown profile: ${profileId}`);
  }
  return readJson(filePath);
}

function loadConfigSchema() {
  return readJson(path.join(ROOT, 'jarvos.config.schema.json'));
}

function resolveDoctorContext(options = {}) {
  const workspace = path.resolve(expandHome(
    options.workspace
    || process.env.JARVOS_WORKSPACE_PATH
    || process.cwd(),
  ));
  const configPath = path.resolve(expandHome(
    options.config
    || process.env.JARVOS_CONFIG_PATH
    || path.join(workspace, 'jarvos.config.json'),
  ));
  return { workspace, configPath };
}

function validateConfigShape(config, schema = loadConfigSchema()) {
  const errors = [];
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    return ['jarvos.config.json must contain a JSON object'];
  }

  for (const field of schema.required || []) {
    if (typeof config[field] !== 'string' || !config[field].trim()) {
      errors.push(`${field} must be a non-empty string`);
    }
  }

  const properties = schema.properties || {};
  for (const [field, definition] of Object.entries(properties)) {
    if (config[field] === undefined) continue;
    if (definition.type && typeof config[field] !== definition.type) {
      errors.push(`${field} must be ${definition.type}`);
    }
  }

  return errors;
}

function result(id, ok, message, detail = '') {
  return { id, ok, message, detail };
}

function checkNodeVersion() {
  const [major] = process.versions.node.split('.').map(Number);
  return result(
    'node-version',
    major >= MIN_NODE_MAJOR,
    `Node.js ${process.versions.node}`,
    major >= MIN_NODE_MAJOR ? '' : `Node.js ${MIN_NODE_MAJOR}+ is required`,
  );
}

function checkWorkspaceFiles(workspace) {
  const missing = REQUIRED_WORKSPACE_FILES.filter((file) => !fs.existsSync(path.join(workspace, file)));
  return result(
    'workspace-files',
    missing.length === 0,
    'required workspace files',
    missing.length ? `Missing: ${missing.join(', ')}` : workspace,
  );
}

function checkConfigSchema(configPath) {
  try {
    const config = readJson(configPath);
    const errors = validateConfigShape(config);
    return result(
      'config-schema',
      errors.length === 0,
      'jarvos.config.json schema',
      errors.length ? errors.join('; ') : configPath,
    );
  } catch (error) {
    return result('config-schema', false, 'jarvos.config.json schema', error.message);
  }
}

function checkVaultPath(configPath) {
  try {
    const config = readJson(configPath);
    const vaultPath = expandHome(config.vaultPath);
    const required = ['Notes', 'Journal', 'Tags'];
    const missing = required.filter((dir) => !fs.existsSync(path.join(vaultPath, dir)));
    return result(
      'vault-path',
      Boolean(vaultPath) && missing.length === 0,
      'vault path',
      missing.length ? `Missing in ${vaultPath || '(unset)'}: ${missing.join(', ')}` : vaultPath,
    );
  } catch (error) {
    return result('vault-path', false, 'vault path', error.message);
  }
}

function checkAgentContextPackage() {
  const modulePath = path.join(ROOT, 'modules', 'jarvos-agent-context', 'src', 'index.js');
  try {
    const agentContext = require(modulePath);
    const expected = ['currentWork', 'hydrate'];
    const missing = expected.filter((name) => typeof agentContext[name] !== 'function');
    return result(
      'agent-context-package',
      missing.length === 0,
      '@jarvos/agent-context',
      missing.length ? `Missing exports: ${missing.join(', ')}` : 'module loads',
    );
  } catch (error) {
    return result('agent-context-package', false, '@jarvos/agent-context', error.message);
  }
}

function runDoctor(options = {}) {
  const profile = loadProfile(options.profile || 'minimal');
  const { workspace, configPath } = resolveDoctorContext(options);
  const checks = {
    'node-version': () => checkNodeVersion(),
    'workspace-files': () => checkWorkspaceFiles(workspace),
    'config-schema': () => checkConfigSchema(configPath),
    'vault-path': () => checkVaultPath(configPath),
    'agent-context-package': () => checkAgentContextPackage(),
  };

  const results = (profile.doctorChecks || []).map((checkId) => {
    const fn = checks[checkId];
    if (!fn) return result(checkId, false, checkId, 'No implementation for this public check');
    return fn();
  });

  return {
    ok: results.every((item) => item.ok),
    profile,
    workspace,
    configPath,
    results,
  };
}

function renderDoctor(report) {
  const lines = [
    `jarvOS doctor — ${report.profile.title}`,
    `Workspace: ${report.workspace}`,
    '',
  ];
  for (const item of report.results) {
    lines.push(`${item.ok ? 'PASS' : 'FAIL'} ${item.id} — ${item.message}${item.detail ? ` (${item.detail})` : ''}`);
  }
  lines.push('');
  lines.push(report.ok ? 'READY' : 'NOT READY');
  return lines.join('\n');
}

function renderHelp() {
  return `jarvOS

Usage:
  jarvos init [--profile minimal] [bootstrap options]
  jarvos doctor [--profile minimal] [--workspace path] [--config path] [--json]
  jarvos help

Profiles:
  minimal  Portable starter workspace, config, vault folders, and agent-context checks.

Compatibility:
  jarvos-bootstrap and jarvos-init still run the original bootstrap path.`;
}

function renderInitHelp() {
  return `jarvos init

Usage:
  jarvos init --profile minimal --yes

Runs the existing bootstrap installer through the public command router.
The --profile flag selects the public install profile; bootstrap-specific flags
such as --yes and --non-interactive are passed through.`;
}

function renderDoctorHelp() {
  return `jarvos doctor

Usage:
  jarvos doctor --profile minimal --workspace /path/to/jarvos-workspace
  jarvos doctor --profile minimal --workspace /path/to/jarvos-workspace --json

Runs the public profile health checks without checking private services,
credentials, Paperclip state, GBrain data, or full-profile local integrations.`;
}

function initPassthroughArgs(argv = []) {
  const out = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--profile') {
      index += 1;
    } else if (arg.startsWith('--profile=')) {
      continue;
    } else {
      out.push(arg);
    }
  }
  return out;
}

function runInit(argv = [], env = process.env) {
  const parsed = parseArgs(['init', ...argv]);
  try {
    loadProfile(parsed.options.profile || 'minimal');
  } catch (error) {
    process.stderr.write(`jarvos init failed: ${error.message}\n`);
    return 1;
  }
  if (parsed.help) {
    process.stdout.write(`${renderInitHelp()}\n`);
    return 0;
  }

  const child = spawnSync(process.execPath, [path.join(ROOT, 'bootstrap.js'), ...initPassthroughArgs(argv)], {
    cwd: ROOT,
    env: {
      ...env,
      JARVOS_PROFILE: parsed.options.profile || 'minimal',
    },
    stdio: 'inherit',
  });

  if (child.error) {
    process.stderr.write(`jarvos init failed: ${child.error.message}\n`);
    return 1;
  }
  return child.status || 0;
}

function runCli(argv = process.argv.slice(2), env = process.env) {
  const parsed = parseArgs(argv);
  if (parsed.command === 'help' || parsed.help && parsed.command !== 'doctor' && parsed.command !== 'init') {
    process.stdout.write(`${renderHelp()}\n`);
    return 0;
  }

  if (parsed.command === 'init') {
    return runInit(argv.slice(1), env);
  }

  if (parsed.command === 'doctor') {
    if (parsed.help) {
      process.stdout.write(`${renderDoctorHelp()}\n`);
      return 0;
    }
    try {
      const report = runDoctor(parsed.options);
      if (parsed.options.json) {
        process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      } else {
        process.stdout.write(`${renderDoctor(report)}\n`);
      }
      return report.ok ? 0 : 1;
    } catch (error) {
      process.stderr.write(`jarvos doctor failed: ${error.message}\n`);
      return 1;
    }
  }

  process.stderr.write(`Unknown command: ${parsed.command}\n\n${renderHelp()}\n`);
  return 1;
}

module.exports = {
  REQUIRED_WORKSPACE_FILES,
  initPassthroughArgs,
  loadProfile,
  parseArgs,
  renderDoctor,
  renderDoctorHelp,
  renderHelp,
  renderInitHelp,
  resolveDoctorContext,
  runCli,
  runDoctor,
  validateConfigShape,
};
