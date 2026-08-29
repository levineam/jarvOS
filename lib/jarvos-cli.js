'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { loadHealthModules } = require('./jarvos-doctor-modules');
const { inspectCompoundEngineeringProvider } = require('../modules/jarvos-runtime-kit/src');
const {
  MANUAL_RECONCILIATION_ACTION,
  assertConfigPublicationSupported,
  assessSharedVaultConfigTarget,
  buildSharedVaultConfig,
  discoverExistingVault,
  manualReconciliationError,
  readSharedVaultConfigTarget,
  requiresConfigPublication,
  writeSharedVaultConfig,
} = require('../modules/jarvos-secondbrain/bridge/config/src/shared-vault-onboarding');
const {
  expandTilde,
  isUsablePath,
  isValidTimezone,
  PATH_ENV_KEYS,
  resolveConfig,
  winningPathEnvKey,
} = require('../modules/jarvos-secondbrain/bridge/config/src/resolve-config');

const ROOT = path.resolve(__dirname, '..');
const MIN_NODE_MAJOR = 18;
const COMMANDS = new Set(['help', 'init', 'sync', 'doctor']);
const LEGACY_INIT_ALIASES = new Set(['jarvos-bootstrap', 'jarvos-init']);
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

// jarvOS writes journal entries into <vault>/Journal. Obsidian can be configured to
// write daily/journal notes into the same place, producing a two-writer conflict that
// can overwrite jarvOS journal content with stubs (the failure mode behind SUP-2269).
const OBSIDIAN_DIR = '.obsidian';
const JOURNAL_SUBDIR = 'Journal';
const OBSIDIAN_JOURNAL_PLUGIN = 'journals';
const OBSIDIAN_PERIODIC_NOTES_PLUGIN = 'periodic-notes';
const OBSIDIAN_DAILY_NOTES_PLUGIN = 'daily-notes';

function expandHome(value, home = os.homedir()) {
  if (!value) return value;
  if (value === '~') return home;
  if (value.startsWith('~/')) return path.join(home, value.slice(2));
  return value;
}

function requireOptionValue(flag, value) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized || normalized.startsWith('-')) {
    throw new Error(`${flag} requires a non-empty path value`);
  }
  return value;
}

function validateInitPathEnvironment(env) {
  for (const name of ['JARVOS_WORKSPACE_PATH', 'JARVOS_VAULT_PATH']) {
    if (Object.prototype.hasOwnProperty.call(env, name)) {
      requireOptionValue(name, env[name]);
    }
  }
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
    } else if (arg === '--workspace') {
      args.options.workspace = requireOptionValue(arg, copy[index + 1]);
      index += 1;
    } else if (arg.startsWith('--workspace=')) {
      args.options.workspace = requireOptionValue('--workspace', arg.slice('--workspace='.length));
    } else if (arg === '--vault') {
      args.options.vault = requireOptionValue(arg, copy[index + 1]);
      index += 1;
    } else if (arg.startsWith('--vault=')) {
      args.options.vault = requireOptionValue('--vault', arg.slice('--vault='.length));
    } else if (arg === '--config' && copy[index + 1]) {
      args.options.config = copy[++index];
    } else if (arg.startsWith('--config=')) {
      args.options.config = arg.slice('--config='.length);
    } else if (arg === '--vault' && copy[index + 1]) {
      args.options.vault = copy[++index];
    } else if (arg.startsWith('--vault=')) {
      args.options.vault = arg.slice('--vault='.length);
    } else if (arg === '--name' && copy[index + 1]) {
      args.options.name = copy[++index];
    } else if (arg.startsWith('--name=')) {
      args.options.name = arg.slice('--name='.length);
    } else if (arg === '--timezone' && copy[index + 1]) {
      args.options.timezone = copy[++index];
    } else if (arg.startsWith('--timezone=')) {
      args.options.timezone = arg.slice('--timezone='.length);
    } else if (arg === '--dry-run') {
      args.options.dryRun = true;
    } else if (arg === '--openclaw-dir' && copy[index + 1]) {
      args.options.openclawStateDir = copy[++index];
    } else if (arg.startsWith('--openclaw-dir=')) {
      args.options.openclawStateDir = arg.slice('--openclaw-dir='.length);
    } else if (arg === '--staged-runtime-root' && copy[index + 1]) {
      args.options.stagedRuntimeRoot = copy[++index];
    } else if (arg.startsWith('--staged-runtime-root=')) {
      args.options.stagedRuntimeRoot = arg.slice('--staged-runtime-root='.length);
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

function listProfiles() {
  const profilesDir = path.join(ROOT, 'profiles');
  if (!fs.existsSync(profilesDir)) return [];
  return fs.readdirSync(profilesDir)
    .filter((entry) => entry.endsWith('.json'))
    .map((entry) => loadProfile(path.basename(entry, '.json')))
    .filter((profile) => profile.public !== false)
    .sort((a, b) => a.id.localeCompare(b.id));
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
  // env/homeDir must come from the same options runDoctor() was itself given
  // (see its call below), not ambient process.env/os.homedir(): those are
  // exactly what a sandboxed or isolated caller (tests, a differently-homed
  // runtime) overrides, and this context feeds every check that follows.
  const env = options.env || process.env;
  const homeDir = options.homeDir || os.homedir();
  const workspace = path.resolve(expandHome(
    options.workspace
    || env.JARVOS_WORKSPACE_PATH
    || process.cwd(),
    homeDir,
  ));
  const configPath = path.resolve(expandHome(
    options.config
    || env.JARVOS_CONFIG_PATH
    || path.join(workspace, 'jarvos.config.json'),
    homeDir,
  ));
  return { workspace, configPath };
}

function configTypeMatches(value, type) {
  if (type === 'array') return Array.isArray(value);
  if (type === 'object') return value !== null && typeof value === 'object' && !Array.isArray(value);
  return typeof value === type;
}

function validateConfigValue(value, schema, instancePath = 'jarvos.config.json') {
  if (!schema || typeof schema !== 'object') return [`${instancePath} has an invalid schema`];

  if (Array.isArray(schema.anyOf)) {
    const matches = schema.anyOf.some((candidate) => validateConfigValue(value, candidate, instancePath).length === 0);
    if (!matches) {
      return [`${instancePath} must use either the legacy bootstrap shape or the portable paths/user shape`];
    }
  }

  if (schema.type && !configTypeMatches(value, schema.type)) {
    return [`${instancePath} must be ${schema.type}`];
  }

  const errors = [];
  if (schema.type === 'object') {
    for (const field of schema.required || []) {
      if (!Object.prototype.hasOwnProperty.call(value, field)) {
        errors.push(`${instancePath}.${field} is required`);
      }
    }
    for (const [field, definition] of Object.entries(schema.properties || {})) {
      if (!Object.prototype.hasOwnProperty.call(value, field)) continue;
      errors.push(...validateConfigValue(value[field], definition, `${instancePath}.${field}`));
    }
  }

  if (schema.format === 'time-zone' && !isValidTimezone(value)) {
    errors.push(`${instancePath} must be a valid IANA timezone`);
  }
  if (schema.format === 'absolute-path' && !isUsablePath(value)) {
    errors.push(`${instancePath} must be an absolute or ~-rooted path the runtime can use`);
  }
  // Whitespace is not content: the pre-schema validator required a non-empty
  // trimmed string, so `--name " "` must stay a validation failure.
  if (schema.type === 'string' && Number.isInteger(schema.minLength) && value.trim().length < schema.minLength) {
    errors.push(`${instancePath} must contain at least ${schema.minLength} non-whitespace character`);
  }

  return errors;
}

// resolveConfig() selects the first non-empty value in this exact precedence
// chain. The legacy spellings are outside the portable JSON schema's
// user.timezone property, so schema validation alone would miss an invalid
// value that the runtime then refuses. Lower-priority values are intentionally
// ignored once a higher-priority value is selected: the runtime never reads
// them, and rejecting them here would make Doctor stricter than the runtime.
// `env` is opt-in for direct config-only validation callers; Doctor passes its
// explicit runtime environment so command reports and runtime selection agree.
function selectedRuntimeTimezone(config, env = null) {
  const candidates = [
    ...(env && typeof env === 'object' ? [['JARVOS_TIMEZONE', env.JARVOS_TIMEZONE]] : []),
    ['user.timezone', config?.user?.timezone],
    ['user.timeZone', config?.user?.timeZone],
    ['timezone', config?.timezone],
    ['timeZone', config?.timeZone],
  ];
  return candidates.find(([, value]) => Boolean(value)) || null;
}

function invalidRuntimeTimezoneAliases(config, env = null) {
  const selected = selectedRuntimeTimezone(config, env);
  if (!selected || selected[0] === 'user.timezone' || isValidTimezone(selected[1])) return [];
  return [selected[0]];
}

function schemaConfigWithRuntimeTimezoneAlias(config, env = null) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) return config;
  const user = config.user && typeof config.user === 'object' && !Array.isArray(config.user)
    ? config.user
    : null;
  // Keep the raw value for invalid-alias reporting below. This normalized copy
  // is solely for the portable schema's canonical user.timezone requirement:
  // the resolver legitimately accepts a non-empty valid legacy alias when
  // that canonical field is absent.
  if (!user) return config;
  const selected = selectedRuntimeTimezone(config, env);
  if (!selected || !isValidTimezone(selected[1])) return config;
  // A valid explicit JARVOS_TIMEZONE wins even over a present (but stale or
  // invalid) canonical value, exactly as resolveUserTimezone() does. With no
  // explicit env selection, preserve an existing canonical field and only
  // bridge a valid legacy alias into the schema copy.
  if (selected[0] === 'user.timezone' && Object.prototype.hasOwnProperty.call(user, 'timezone')) return config;
  return { ...config, user: { ...user, timezone: selected[1] } };
}

function validateConfigShape(config, schema = loadConfigSchema(), options = {}) {
  return [
    ...validateConfigValue(schemaConfigWithRuntimeTimezoneAlias(config, options.env), schema),
    ...invalidRuntimeTimezoneAliases(config, options.env)
      .map((field) => `jarvos.config.json.${field} must be a valid IANA timezone`),
  ];
}

// Remediation has to be truthful: jarvos sync never rewrites an existing
// config in place, whether it is conflicting or merely legacy-shaped.
const UNUSABLE_VAULT_PATH_DETAIL = 'paths.vault is not configured with a runtime-effective path '
  + '(it must be absolute or ~-rooted; the runtime ignores a relative value and falls back to the '
  + 'home default vault). Edit jarvos.config.json to an absolute or ~-rooted vault path, or run '
  + 'jarvos sync with a separate explicit --config path; sync refuses to rewrite the '
  + 'existing config in place.';

function legacyMigrationAssessment(config, configPath, options = {}) {
  const homeDir = options.homeDir || os.homedir();
  const vaultPath = typeof config?.vaultPath === 'string' && isUsablePath(config.vaultPath, homeDir)
    ? expandTilde(config.vaultPath.trim(), homeDir)
    : null;
  const workspacePath = typeof config?.workspacePath === 'string' && isUsablePath(config.workspacePath, homeDir)
    ? expandTilde(config.workspacePath.trim(), homeDir)
    : null;
  const recordedName = config?.user?.name ?? config?.userName;
  const recordedTimezone = config?.user?.timezone ?? config?.user?.timeZone ?? config?.timezone ?? config?.timeZone;
  // An absent or empty identity can be supplied when creating a separate
  // portable config. A present-but-invalid value is not silently replaced:
  // that could turn a genuine compatibility conflict into misleading advice.
  const hasName = typeof recordedName === 'string' && Boolean(recordedName.trim());
  const hasTimezone = typeof recordedTimezone === 'string' && Boolean(recordedTimezone.trim());
  if (!vaultPath || !workspacePath
    || (recordedName !== undefined && recordedName !== '' && !hasName)
    || (recordedTimezone !== undefined && recordedTimezone !== '' && !hasTimezone)
    || (hasTimezone && !isValidTimezone(recordedTimezone))) return null;
  const name = hasName ? recordedName.trim() : 'Your Name';
  const timezone = hasTimezone ? recordedTimezone : 'UTC';

  try {
    const candidate = buildSharedVaultConfig({
      vaultDir: vaultPath,
      // Match runSync(), which normalizes --workspace before building the
      // candidate. Keeping a raw trailing/dot spelling here would falsely
      // classify a target as manual-reconcile when the command correctly
      // refuses it as a conflicting existing config.
      workspaceRoot: path.resolve(workspacePath),
      homeDir,
      user: { name: name.trim(), timezone },
    });
    const assessment = assessSharedVaultConfigTarget({ configPath, config: candidate, vaultDir: vaultPath, homeDir });
    if (assessment.action !== 'migrate') return null;
    return {
      vaultPath,
      workspacePath,
      configPath: assessment.configPath,
      needsName: !hasName,
      needsTimezone: !hasTimezone,
    };
  } catch {
    // Doctor remediation must not guess that a malformed or divergent target
    // can be reconciled automatically. The generic path guidance is safer.
    return null;
  }
}

// This is deliberately an assessment only. Doctor must surface an existing
// config that sync would classify as compatible-but-not-portable without
// attempting to publish or reconcile anything. Keeping the comparison on the
// same buildSharedVaultConfig()/assessSharedVaultConfigTarget() path as sync
// prevents a second, subtly different definition of "legacy but compatible"
// in the public and profile Doctor entry points.
function assessDoctorConfigReconciliation(config, configPath, options = {}) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) return null;

  const homeDir = options.homeDir || os.homedir();
  const configuredPaths = config.paths && typeof config.paths === 'object' ? config.paths : {};
  const vaultInput = configuredPaths.vault ?? config.vaultPath;
  const workspaceInput = configuredPaths.workspace ?? config.workspacePath;
  if (!isUsablePath(vaultInput, homeDir) || !isUsablePath(workspaceInput, homeDir)) return null;

  const name = config.user?.name ?? config.userName;
  const timezone = config.user?.timezone
    ?? config.user?.timeZone
    ?? config.timezone
    ?? config.timeZone;
  if (typeof name !== 'string' || !name.trim() || !isValidTimezone(timezone)) return null;

  const vaultDir = expandTilde(vaultInput.trim(), homeDir);
  const workspaceRoot = expandTilde(workspaceInput.trim(), homeDir);
  try {
    const expected = buildSharedVaultConfig({
      vaultDir,
      workspaceRoot,
      homeDir,
      user: { name: name.trim(), timezone },
    });
    const assessment = assessSharedVaultConfigTarget({
      configPath,
      config: expected,
      vaultDir,
      homeDir,
    });
    if (assessment.action !== 'migrate') return null;
    return {
      action: MANUAL_RECONCILIATION_ACTION,
      configPath: assessment.configPath,
      detail: `This existing config is compatible with a portable shared-installation config but requires manual reconciliation. `
        + `jarvos sync will not modify ${assessment.configPath}. Reconcile it manually, or pass --config <new-path> to create a separate portable config.`,
    };
  } catch {
    // A malformed, inaccessible, or conflicting target is owned by the
    // existing schema/config/path checks. Do not turn it into a misleading
    // manual-reconciliation recommendation.
    return null;
  }
}

function unusableVaultPathDetail(config, configPath, options = {}) {
  const legacy = legacyMigrationAssessment(config, configPath, options);
  if (legacy) {
    const identityHint = legacy.needsName || legacy.needsTimezone
      ? ` Supply ${legacy.needsName ? '--name "Your Name"' : ''}${legacy.needsName && legacy.needsTimezone ? ' and ' : ''}${legacy.needsTimezone ? '--timezone Area/City' : ''} when creating the separate config.`
      : '';
    return `Legacy config records a usable vaultPath at ${legacy.vaultPath}, but it is not a runtime-effective paths.vault setting. `
      + `jarvos sync will report this existing file as requiring manual reconciliation and will not modify ${legacy.configPath}. `
      + 'Preserve the existing config while reconciling it manually, or pass --config <new-path> to create a separate portable config.'
      + identityHint;
  }
  return UNUSABLE_VAULT_PATH_DETAIL;
}

function configuredVaultPath(config, homeDir = os.homedir()) {
  const configured = config?.paths?.vault;
  // Apply the runtime's own gate, then expand with the runtime's own helper.
  // resolveConfig() drops a relative paths.vault and falls back to the home
  // default, so inspecting one here would resolve it against the process cwd
  // and could report health for a directory the runtime never touches.  Using
  // expandTilde keeps `~\`-rooted values expanding exactly as the runtime does,
  // which the gate already accepts.
  if (!isUsablePath(configured, homeDir)) return null;
  return expandTilde(configured.trim(), homeDir);
}

// Matches only assertNotStaleVaultPath()/assertWithinRequiredVault()'s own
// thrown messages (resolve-config.js's SUP-1307/SUP-1884 guards). resolveConfig()
// throws for other reasons too (e.g. an invalid IANA timezone) while resolving
// the same call; misattributing those to the vault guard would blame
// vault-path/vault-path-stale/journal-conflict for a failure config-schema
// validation already owns. Mirrors modules/jarvos/src/doctor.js's own
// VAULT_PATH_GUARD_ERROR_PATTERN so the CLI and module doctors classify the
// same resolveConfig() throw the same way.
const VAULT_PATH_GUARD_ERROR_PATTERN = /stale vault path|outside the required canonical vault/;

function isVaultGuardError(error) {
  return Boolean(error) && typeof error.message === 'string' && VAULT_PATH_GUARD_ERROR_PATTERN.test(error.message);
}

function vaultGuardFailureDetail(error, label) {
  return `The runtime's own resolver refuses this configuration, so ${label} cannot be reported healthy: ${error.message}`;
}

// Which vault directory the runtime would actually use for this configPath.
// JARVOS_VAULT_DIR (or any future PATH_ENV_KEYS.vault alias) overrides
// paths.vault unconditionally in resolveConfig(); a check that only ever
// inspected paths.vault could report a healthy config-only vault while the
// runtime writes journal/notes/tags into a completely different, possibly
// broken, directory. winningPathEnvKey() names the exact env var that would
// win, so the divergence can be surfaced truthfully rather than silently
// resolved to one side or the other.
//
// resolveConfig() is always attempted, even with no env override: its own
// stale-vault and JARVOS_REQUIRE_CANONICAL_VAULT guards can refuse a
// configured-only (or even a default) vault outright, and a check that only
// ever consulted paths.vault would silently report that refused vault
// healthy. runtimePaths carries the full resolved paths object so
// journal-conflict can read the runtime-effective paths.journal from this
// same call, rather than re-deriving it by hand.
function effectiveVaultTarget(config, configPath, options = {}) {
  const env = options.env || process.env;
  const homeDir = options.homeDir || os.homedir();
  const configuredPath = configuredVaultPath(config, homeDir);
  const overrideKey = winningPathEnvKey(PATH_ENV_KEYS.vault, env, homeDir);

  let runtime = null;
  let runtimeVault = null;
  let guardError = null;
  try {
    runtime = resolveConfig({ configPath, homeDir, env });
    runtimeVault = runtime.paths.vault;
  } catch (error) {
    if (isVaultGuardError(error)) {
      guardError = error;
    } else if (overrideKey) {
      // resolveConfig() can throw for reasons unrelated to the vault override
      // (e.g. an invalid timezone elsewhere in the same config); fall back to
      // exactly what firstEnvPath() would compute for this override, since
      // winningPathEnvKey() already confirmed env[overrideKey] is usable.
      runtimeVault = expandTilde(env[overrideKey].trim(), homeDir);
    }
    // Otherwise: an unrelated resolveConfig() failure with no env override —
    // config-schema/timezone validation owns that failure, not this check, so
    // fall through and keep judging the configured-only value below.
  }

  if (guardError) {
    // Do not swallow the guard into a raw path and report healthy: no vault
    // is safe to inspect when the runtime itself would refuse to start from
    // one, so every caller must fail closed on this truthful diagnostic.
    return {
      vaultPath: null, configuredPath, overrideKey: overrideKey || null, guardError, runtimePaths: null,
    };
  }

  if (!overrideKey) {
    // No override and no guard failure: preserve the config-only requirement
    // that paths.vault be explicit — never silently accept the runtime's
    // home-directory default as "healthy".
    return {
      vaultPath: configuredPath, configuredPath, overrideKey: null, runtimePaths: runtime ? runtime.paths : null,
    };
  }

  const overridden = !configuredPath || path.resolve(runtimeVault) !== path.resolve(configuredPath);
  return {
    vaultPath: runtimeVault,
    configuredPath,
    overrideKey: overridden ? overrideKey : null,
    runtimePaths: runtime ? runtime.paths : null,
  };
}

// Truthfully names drift between the runtime-effective vault and paths.vault;
// empty when there is no override or the override happens to agree.
function vaultOverrideNote(target) {
  if (!target.overrideKey) return '';
  return ` (via ${target.overrideKey} environment override; paths.vault configures ${target.configuredPath || '(not configured)'})`;
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

function checkConfigSchema(configPath, options = {}) {
  try {
    const config = readJson(configPath);
    // Match resolveConfig(): an omitted env uses the process environment,
    // while an explicit empty object remains an intentional isolated env.
    const env = options.env || process.env;
    const errors = validateConfigShape(config, loadConfigSchema(), { env });
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

function checkConfigReconciliation(configPath, options = {}, config = undefined) {
  let resolvedConfig = config;
  if (resolvedConfig === undefined) {
    try {
      resolvedConfig = readJson(configPath);
    } catch {
      // config-schema owns a missing or invalid config. A successful
      // reconciliation check here only means no compatible legacy target was
      // identified; it never overrides that separate failure.
      resolvedConfig = null;
    }
  }
  const assessment = assessDoctorConfigReconciliation(resolvedConfig, configPath, options);
  if (assessment) {
    return result('config-reconciliation', false, 'config reconciliation', assessment.detail);
  }
  return result(
    'config-reconciliation',
    true,
    'config reconciliation',
    'No compatible legacy configuration requires a Doctor reconciliation recommendation',
  );
}

function checkVaultPath(configPath, options = {}) {
  try {
    const config = readJson(configPath);
    const target = effectiveVaultTarget(config, configPath, options);
    if (target.guardError) {
      return result('vault-path', false, 'vault path', vaultGuardFailureDetail(target.guardError, 'the vault path'));
    }
    const vaultPath = target.vaultPath;
    if (!vaultPath) {
      return result('vault-path', false, 'vault path', unusableVaultPathDetail(config, configPath, options));
    }
    const note = vaultOverrideNote(target);
    const required = ['Notes', 'Journal', 'Tags'];
    const missing = required.filter((dir) => !fs.statSync(path.join(vaultPath, dir), { throwIfNoEntry: false })?.isDirectory());
    return result(
      'vault-path',
      Boolean(vaultPath) && missing.length === 0,
      'vault path',
      missing.length ? `Missing in ${vaultPath}${note}: ${missing.join(', ')}` : `${vaultPath}${note}`,
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

// Pure assessment for doctor detail selection. Public package/runtime surface is
// always required. Live host readiness is optional for a fresh generic minimal
// install; when JARVOS_CONTROL_PLANE_SERVICE_MODULE is set, it must be usable.
function assessControlPlaneDoctor({
  hasCreateService,
  hasContextControlPlane,
  hasVerifyHost,
  compatible,
  dependency,
  hostConfigured,
  hostReady,
}) {
  const exportsOk = Boolean(hasCreateService && hasContextControlPlane && hasVerifyHost);
  const publicOk = exportsOk && Boolean(compatible) && Boolean(dependency);
  const ok = publicOk && (!hostConfigured || hostReady);

  if (ok) {
    return {
      ok: true,
      detail: hostConfigured
        ? 'authenticated host service, package dependency, and shared CLI/MCP runtime declarations validated'
        : 'public module exports, package dependency, and shared CLI/MCP runtime declarations validated (host service not configured)',
    };
  }

  if (!exportsOk) {
    const missing = [];
    if (!hasCreateService) missing.push('createControlPlaneService');
    if (!hasContextControlPlane) missing.push('controlPlane');
    if (!hasVerifyHost) missing.push('verifyHostService');
    return {
      ok: false,
      detail: `control plane is not ready: missing public exports (${missing.join(', ')})`,
    };
  }
  if (!compatible) {
    return {
      ok: false,
      detail: 'control plane is not ready: Codex runtime must declare the control-plane module, JARVOS_CONTROL_PLANE_SERVICE_MODULE host boundary, and jarvos_control_plane tool',
    };
  }
  if (!dependency) {
    return {
      ok: false,
      detail: 'control plane is not ready: @jarvos/agent-context must depend on @jarvos/control-plane@0.1.0',
    };
  }
  return {
    ok: false,
    detail: 'control plane is not ready: configure a usable JARVOS_CONTROL_PLANE_SERVICE_MODULE (doctor does not print its value)',
  };
}

function checkControlPlaneModule(options = {}) {
  const modulePath = path.join(ROOT, 'modules', 'jarvos-control-plane', 'scripts', 'jarvos-manager.js');
  const env = options.env || process.env;
  try {
    const manager = require(modulePath);
    const context = require(path.join(ROOT, 'modules', 'jarvos-agent-context', 'src', 'index.js'));
    const codex = readJson(path.join(ROOT, 'runtimes', 'codex', 'adapter.json'));
    const agentContextPackage = readJson(path.join(ROOT, 'modules', 'jarvos-agent-context', 'package.json'));
    const hasCreateService = typeof manager.createControlPlaneService === 'function';
    const hasContextControlPlane = typeof context.controlPlane === 'function';
    const hasVerifyHost = typeof manager.verifyHostService === 'function';
    const compatible = codex.controlPlane?.module === 'modules/jarvos-control-plane/scripts/jarvos-manager.js'
      && codex.controlPlane?.hostService === 'JARVOS_CONTROL_PLANE_SERVICE_MODULE'
      && codex.sharedAgentContext?.requiredTools?.includes('jarvos_control_plane');
    const dependency = agentContextPackage.dependencies?.['@jarvos/control-plane'] === '0.1.0';
    const hostModule = env.JARVOS_CONTROL_PLANE_SERVICE_MODULE;
    const hostConfigured = Boolean(hostModule);
    const hostReady = hostConfigured
      && hasVerifyHost
      && manager.verifyHostService(hostModule).ok;
    const assessment = assessControlPlaneDoctor({
      hasCreateService,
      hasContextControlPlane,
      hasVerifyHost,
      compatible,
      dependency,
      hostConfigured,
      hostReady,
    });
    return result(
      'control-plane-module',
      assessment.ok,
      '@jarvos/control-plane parity module',
      assessment.detail,
    );
  } catch (error) {
    return result('control-plane-module', false, '@jarvos/control-plane parity module', error.message);
  }
}

function checkCompoundEngineeringProvider(options = {}) {
  const inspection = inspectCompoundEngineeringProvider({
    root: ROOT,
    executable: options.codexExecutable,
    env: options.env || process.env,
    evidence: options.codexProviderEvidence,
  });
  const status = inspection.status || 'incompatible';
  const ok = status !== 'incompatible';
  const approved = inspection.capability?.approvedVersion || 'unknown';
  const active = inspection.discovery?.activeVersion || 'none';
  const detail = `${status}; approved ${approved}; discovered ${active}; ${inspection.recoveryAction || 'rerun doctor after provider review'}`;
  return result('compound-engineering-provider', ok, 'Compound Engineering provider', detail);
}

function readJsonSafe(filePath) {
  try {
    return { ok: true, value: JSON.parse(fs.readFileSync(filePath, 'utf8')) };
  } catch (error) {
    return { ok: false, error };
  }
}

function checkVaultPathStale(configPath, options = {}) {
  // Distinct from vault-path (which validates the Notes/Journal/Tags subfolders): this
  // catches a configured vaultPath whose ROOT has gone away — moved, renamed, or pointed
  // at a stale location after a vault migration. A vault path that silently no longer
  // exists is how journal/knowledge writes start landing in the wrong place.
  try {
    const config = readJson(configPath);
    const target = effectiveVaultTarget(config, configPath, options);
    if (target.guardError) {
      return result('vault-path-stale', false, 'vault path freshness', vaultGuardFailureDetail(target.guardError, 'vault path freshness'));
    }
    const vaultPath = target.vaultPath;
    if (!vaultPath) {
      return result('vault-path-stale', false, 'vault path freshness', unusableVaultPathDetail(config, configPath, options));
    }
    const note = vaultOverrideNote(target);
    if (!fs.existsSync(vaultPath)) {
      return result(
        'vault-path-stale',
        false,
        'vault path freshness',
        `Configured vaultPath does not exist (stale or moved vault): ${vaultPath}${note}`,
      );
    }
    if (!fs.statSync(vaultPath).isDirectory()) {
      return result('vault-path-stale', false, 'vault path freshness', `Configured vaultPath is not a directory: ${vaultPath}${note}`);
    }
    const isObsidianVault = fs.existsSync(path.join(vaultPath, OBSIDIAN_DIR));
    return result(
      'vault-path-stale',
      true,
      'vault path freshness',
      isObsidianVault ? `${vaultPath}${note}` : `${vaultPath} (no ${OBSIDIAN_DIR}/ yet — not an Obsidian vault)${note}`,
    );
  } catch (error) {
    return result('vault-path-stale', false, 'vault path freshness', error.message);
  }
}

function communityPluginEnabled(community, pluginId) {
  return community.ok && Array.isArray(community.value) && community.value.includes(pluginId);
}

function folderOverlapsJournal(folder, vaultPath, journalDir) {
  // A daily/periodic note folder conflicts with the jarvOS journal when it IS the
  // journal folder, sits at the vault root (notes land everywhere), or nests either
  // way against Journal/.
  const noteFolder = folder ? path.resolve(vaultPath, folder) : path.resolve(vaultPath);
  return noteFolder === journalDir
    || noteFolder === path.resolve(vaultPath)
    || noteFolder.startsWith(`${journalDir}${path.sep}`)
    || journalDir.startsWith(`${noteFolder}${path.sep}`);
}

function checkJournalConflict(configPath, options = {}) {
  // Guards against the double-writer incident (SUP-2269): if Obsidian's own journal
  // automation — the community "journals" or "periodic-notes" plugin, or the core
  // "daily-notes" plugin — is enabled and writes into the same folder jarvOS uses for
  // journal entries, the two tools fight over the same files and can clobber jarvOS
  // journal content with stubs.
  try {
    const config = readJson(configPath);
    const target = effectiveVaultTarget(config, configPath, options);
    if (target.guardError) {
      return result('journal-conflict', false, 'journal writer conflict', vaultGuardFailureDetail(target.guardError, 'the journal writer conflict check'));
    }
    const vaultPath = target.vaultPath;
    const note = vaultOverrideNote(target);
    if (!vaultPath || !fs.existsSync(vaultPath)) {
      // No vault to inspect — vault-path-stale owns that failure; nothing can conflict.
      return result('journal-conflict', true, 'journal writer conflict', `no vault to inspect${note}`);
    }
    const obsidianDir = path.join(vaultPath, OBSIDIAN_DIR);
    if (!fs.existsSync(obsidianDir)) {
      return result('journal-conflict', true, 'journal writer conflict', `no .obsidian config — jarvOS is the sole journal writer${note}`);
    }

    const conflicts = [];
    // The runtime-effective journal directory — paths.journal, or
    // JARVOS_JOURNAL_DIR/JOURNAL_DIR (PATH_ENV_KEYS.journal) — can diverge
    // from <vault>/Journal; resolveConfig() already computed it as part of
    // effectiveVaultTarget()'s own call, so reuse that rather than
    // hard-coding the vault-relative default here and silently comparing
    // Obsidian's daily-notes folder against a folder jarvOS does not
    // actually journal into.
    const journalDir = path.resolve(target.runtimePaths?.journal || path.join(vaultPath, JOURNAL_SUBDIR));

    const community = readJsonSafe(path.join(obsidianDir, 'community-plugins.json'));
    if (communityPluginEnabled(community, OBSIDIAN_JOURNAL_PLUGIN)) {
      conflicts.push('Obsidian community plugin "journals" is enabled');
    }

    // Periodic Notes (community plugin) also creates daily/periodic notes, but in a
    // configurable folder — only flag it when that folder overlaps the jarvOS journal.
    if (communityPluginEnabled(community, OBSIDIAN_PERIODIC_NOTES_PLUGIN)) {
      const pnCfg = readJsonSafe(path.join(obsidianDir, 'plugins', OBSIDIAN_PERIODIC_NOTES_PLUGIN, 'data.json'));
      const daily = pnCfg.ok && pnCfg.value && typeof pnCfg.value === 'object' ? pnCfg.value.daily : null;
      const dailyEnabled = !pnCfg.ok || !daily || daily.enabled !== false; // default-on unless explicitly disabled
      const folder = daily && typeof daily.folder === 'string' ? daily.folder.trim() : '';
      if (dailyEnabled && folderOverlapsJournal(folder, vaultPath, journalDir)) {
        conflicts.push(`Obsidian "periodic-notes" daily notes write to ${folder || '(vault root)'}, overlapping jarvOS Journal`);
      }
    }

    const core = readJsonSafe(path.join(obsidianDir, 'core-plugins.json'));
    const coreEnabled = core.ok && (
      (Array.isArray(core.value) && core.value.includes(OBSIDIAN_DAILY_NOTES_PLUGIN))
      || (core.value && typeof core.value === 'object' && core.value[OBSIDIAN_DAILY_NOTES_PLUGIN] === true)
    );
    if (coreEnabled) {
      const dailyCfg = readJsonSafe(path.join(obsidianDir, 'daily-notes.json'));
      const folder = dailyCfg.ok && typeof dailyCfg.value.folder === 'string' ? dailyCfg.value.folder.trim() : '';
      if (folderOverlapsJournal(folder, vaultPath, journalDir)) {
        conflicts.push(`Obsidian core "daily-notes" writes to ${folder || '(vault root)'}, overlapping jarvOS Journal`);
      }
    }

    if (conflicts.length) {
      return result(
        'journal-conflict',
        false,
        'journal writer conflict',
        `${conflicts.join('; ')}. Disable it so jarvOS stays the single journal writer (see SUP-2269).${note}`,
      );
    }
    return result('journal-conflict', true, 'journal writer conflict', `jarvOS is the single journal writer${note}`);
  } catch (error) {
    return result('journal-conflict', false, 'journal writer conflict', error.message);
  }
}

function runDoctor(options = {}) {
  const profile = loadProfile(options.profile || 'minimal');
  const { workspace, configPath } = resolveDoctorContext(options);
  let config = null;
  try {
    config = readJson(configPath);
  } catch {
    // config-schema reports the parse failure; optional module loading stays fail-closed.
  }
  const checks = {
    'node-version': () => checkNodeVersion(),
    'workspace-files': () => checkWorkspaceFiles(workspace),
    'config-schema': () => checkConfigSchema(configPath, options),
    'config-reconciliation': () => checkConfigReconciliation(configPath, options, config),
    'vault-path': () => checkVaultPath(configPath, options),
    'vault-path-stale': () => checkVaultPathStale(configPath, options),
    'journal-conflict': () => checkJournalConflict(configPath, options),
    'agent-context-package': () => checkAgentContextPackage(),
    'control-plane-module': () => checkControlPlaneModule(),
    'compound-engineering-provider': () => checkCompoundEngineeringProvider(options),
  };

  const checkIds = [...(profile.doctorChecks || [])];
  if (!checkIds.includes('config-reconciliation')) checkIds.splice(checkIds.indexOf('config-schema') + 1, 0, 'config-reconciliation');
  const results = checkIds.map((checkId) => {
    const fn = checks[checkId];
    if (!fn) return result(checkId, false, checkId, 'No implementation for this public check');
    return fn();
  });

  const modules = loadHealthModules({
    workspace,
    now: options.now || new Date(),
    expectedContinuity: config?.gbrainContinuity?.required === true,
  }).modules;
  const continuityRequired = config?.gbrainContinuity?.required === true;
  const moduleBlocking = modules.some((module) => healthModuleBlocksDoctor(module, { continuityRequired }));

  return {
    ok: results.every((item) => item.ok) && !moduleBlocking,
    profile,
    workspace,
    configPath,
    results,
    modules,
  };
}

function healthModuleBlocksDoctor(module, { continuityRequired = false } = {}) {
  return ['repair needed', 'needs your attention'].includes(module?.state)
    && (module.id !== 'gbrain-continuity' || continuityRequired);
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
  if (report.modules?.length) {
    lines.push('', 'Optional modules:');
    for (const module of report.modules) {
      const label = module.id === 'memory' ? 'Memory' : module.id;
      lines.push(`${label} — ${module.state}`);
    }
  }
  lines.push('');
  lines.push(report.ok ? 'READY' : 'NOT READY');
  return lines.join('\n');
}

function renderHelp() {
  const profiles = listProfiles();
  const profileLines = profiles.length
    ? profiles.map((profile) => `  ${profile.id.padEnd(8)} ${profile.description || profile.title}`).join('\n')
    : '  minimal  Portable starter workspace, config, vault folders, and agent-context checks.';
  return `jarvOS

Usage:
  jarvos init [--profile minimal] [--workspace path] [--vault path] [--use-existing-vault] [bootstrap options]
  jarvos sync --workspace path [--vault path] [--name name] [--timezone zone] [--dry-run]
  jarvos doctor [--profile minimal|local-openclaw|v0-5-0] [--workspace path] [--config path] [--json]
  jarvos help

Profiles:
${profileLines}

Compatibility:
  jarvos-bootstrap and jarvos-init route to jarvos init for one migration release.`;
}

function renderInitHelp() {
  const profiles = listProfiles();
  const profileLines = profiles.length
    ? profiles.map((profile) => `  ${profile.id.padEnd(8)} ${profile.title}`).join('\n')
    : '  minimal  Minimal';
  return `jarvos init

Usage:
  jarvos init --profile minimal --yes
  jarvos init --profile minimal --workspace /path/to/workspace --vault /path/to/vault --yes

Creates a new standalone jarvOS installation through the public command router.
The --profile flag selects the public install profile; bootstrap-specific flags
such as --yes and --non-interactive are passed through.

Path selection:
  --workspace path  Explicit workspace target for this installation.
  --vault path      Explicit vault target for this installation.
  --use-existing-vault  Attach a verified existing vault to a new workspace.

For automation, JARVOS_WORKSPACE_PATH and JARVOS_VAULT_PATH remain supported.
The command prints the resolved workspace, vault, and intended action before it
writes. It refuses an existing non-empty workspace or vault unless it recognizes
a compatible prior bootstrap installation. Pass --use-existing-vault only for
a new/empty workspace and a vault containing Notes/, Journal/, and Tags/.
Symlinked paths are read-only only when they are a recognized compatible install.
Use jarvos sync to attach to an existing jarvOS installation instead.

Profiles:
${profileLines}`;
}

function renderDoctorHelp() {
  return `jarvos doctor

Usage:
  jarvos doctor --profile minimal --workspace /path/to/jarvos-workspace
  jarvos doctor --profile local-openclaw --workspace /path/to/jarvos-workspace --json

Runs the public profile health checks without checking private services,
credentials, Paperclip state, or full-profile local integrations. The
local-openclaw profile also performs a read-only plugin-persistence check.

Checks include vault-path-stale (the configured vault root still exists) and
journal-conflict (Obsidian's own daily-notes/journals automation is not writing
into the same folder jarvOS journals into), which guard against lost-journal
incidents from a moved vault or a second journal writer.

Use --openclaw-dir to inspect an explicit OpenClaw state directory and
--staged-runtime-root to point at an explicit staged jarvOS runtime root.`;
}

function renderSyncHelp() {
  return `jarvos sync — Sync with an existing jarvOS installation

Usage:
  jarvos sync --workspace /path/to/workspace --vault /path/to/vault \\
    --name "Your Name" --timezone Area/City --dry-run

Creates a portable jarvos.config.json that points this harness at the existing
jarvOS vault. In ordinary, uncontended use the command validates Notes/,
Journal/, and Tags/ and writes no config contents inside the vault. Use --dry-run first. Applying the plan
creates a new config only; it refuses to replace any different existing config,
and an identical portable config is treated as already synced. A compatible
legacy-shaped config is reported as manual-reconcile: jarvOS never rewrites an
existing config in place. Reconcile that file manually, or pass --config to a
new path. For an existing portable config, --vault, --name, and --timezone may
be omitted: jarvOS reuses those exact configured values.

If --vault is omitted, jarvOS uses ~/Vaults/Vault v3 only when it is the single
recognized vault. --workspace is always required so a typo cannot fall back to
~/clawd. Run jarvos doctor against the workspace after syncing.

In ordinary, uncontended use sync selects the config directory outside the vault
and writes no config contents there. JSON output reports this observation as
vaultWrites and vaultContentsWritten, which remain false for the completed
operation. Sync never enumerates or removes vault paths. A failed create may
leave an empty 0600 config target that needs manual removal; sync never removes
any pathname during cleanup. If simultaneous local filesystem changes are
observed by the identity checks, sync fails closed. The OS does not provide a
transaction against every same-account change in the narrow intervals between
checks.

Sync runs on macOS and Linux; it pins the config directory's identity with a
POSIX directory descriptor and rechecks it before and after writing. It creates
the final target with O_EXCL through a retained file descriptor, verifies that
the target pathname still names that descriptor, fsyncs when available, and
reads the exact bytes back through the descriptor before reporting success. A
directory or target substituted during the run fails closed. It fails closed
where the directory descriptor is unavailable. --dry-run never writes.`;
}

function renderSyncResult(payload) {
  const lines = [
    'jarvOS sync — Sync with an existing jarvOS installation',
    `Mode: ${payload.manualReconciliation ? 'MANUAL RECONCILIATION REQUIRED' : (payload.dryRun ? 'DRY RUN' : (payload.changed ? 'APPLIED' : 'ALREADY SYNCED'))}`,
    `Workspace: ${payload.workspace}`,
    `Vault: ${payload.vault}`,
    `Config: ${payload.configPath}`,
    `Config action: ${payload.targetAction}`,
    `Vault writes observed: none`,
  ];
  if (payload.manualReconciliation) {
    lines.push(`Reason: ${payload.message || 'jarvOS will not rewrite the existing config in place.'}`);
    lines.push('Next: reconcile the existing config manually, or rerun with --config pointing to a new path.');
  }
  if (payload.dryRun) lines.push('Filesystem writes: none');
  if (!payload.manualReconciliation) {
    const defaultConfigPath = path.join(payload.workspace, 'jarvos.config.json');
    const configArgument = payload.configPath === defaultConfigPath ? '' : ` --config ${JSON.stringify(payload.configPath)}`;
    lines.push(`Next: jarvos doctor --profile minimal --workspace ${JSON.stringify(payload.workspace)}${configArgument}`);
  }
  return lines.join('\n');
}

function runSync(argv = [], env = process.env, { platform = process.platform, constants = fs.constants } = {}) {
  const parsed = parseArgs(['sync', ...argv]);
  if (parsed.help) {
    process.stdout.write(`${renderSyncHelp()}\n`);
    return 0;
  }

  try {
    if (parsed.passthrough.length) {
      throw new Error(`Unknown sync argument: ${parsed.passthrough[0]}`);
    }
    if (!parsed.options.workspace) {
      throw new Error('--workspace is required; jarvOS will not default a sync target to ~/clawd');
    }
    const homeDir = env.HOME || os.homedir();
    const workspace = path.resolve(expandHome(parsed.options.workspace, homeDir));
    const configPath = path.resolve(expandHome(
      parsed.options.config || path.join(workspace, 'jarvos.config.json'),
      homeDir,
    ));
    const existingConfig = readSharedVaultConfigTarget({ configPath, homeDir });
    const existing = existingConfig.config;
    // Only inherit a configured vault the runtime would actually use. A
    // relative or blank value would be anchored to process.cwd(), letting the
    // directory sync happens to run from decide the vault, so those are never
    // promoted. A usable legacy vaultPath remains an input for resolving the
    // shared vault, but a legacy target is never rewritten in place.
    const usableVault = (value) => (isUsablePath(value, homeDir) ? value.trim() : null);
    const vaultDir = parsed.options.vault
      || usableVault(existing?.paths?.vault)
      || usableVault(existing?.vaultPath)
      || discoverExistingVault({ homeDir });
    if (!vaultDir) {
      throw new Error('No existing jarvOS vault was found; pass --vault explicitly');
    }
    const user = {
      name: parsed.options.name || existing?.user?.name || existing?.userName,
      timezone: parsed.options.timezone
        || existing?.user?.timezone
        || existing?.user?.timeZone
        || existing?.timezone
        || existing?.timeZone,
    };
    if (!user.name) {
      throw new Error('--name is required unless the existing config supplies a name');
    }
    if (!user.timezone) {
      throw new Error('--timezone is required unless the existing config supplies a timezone');
    }
    const config = buildSharedVaultConfig({ vaultDir, workspaceRoot: workspace, homeDir, user });
    const configErrors = validateConfigShape(config);
    if (configErrors.length) {
      throw new Error(`Generated config is invalid: ${configErrors.join('; ')}`);
    }

    const targetAssessment = assessSharedVaultConfigTarget({ configPath, config, vaultDir, homeDir });
    if (targetAssessment.action === 'conflict') {
      throw new Error(
        `Refusing to overwrite an existing jarvos.config.json: ${configPath}. `
        + 'Choose a new --config path or reconcile the existing config manually.',
      );
    }
    const manualReconciliation = targetAssessment.action === 'migrate';
    // A dry run remains useful for a legacy target, but must not present an
    // in-place migration as something apply can do. Apply stops before any
    // reread or filesystem mutation with the same manual-reconciliation
    // diagnostic used by the module entry point.
    if (manualReconciliation && !parsed.options.dryRun) {
      throw manualReconciliationError(configPath);
    }
    // Plan and apply must agree for the one writable action: refuse to report a
    // plannable create on a platform where applying it is guaranteed to fail.
    // Already-synced and manual-reconcile targets remain read-only.
    if (requiresConfigPublication(targetAssessment.action)) {
      assertConfigPublicationSupported(platform, constants);
    }

    let changed = false;
    let written = null;
    if (!parsed.options.dryRun && !manualReconciliation) {
      written = writeSharedVaultConfig({
        configPath,
        vaultDir,
        workspaceRoot: workspace,
        homeDir,
        platform,
        constants,
        user,
      });
      changed = written.changed;
    }

    // The payload must describe the config that is/will be effective, not
    // just the freshly built canonical shape: an 'already-synced' target is
    // never written, so its actual on-disk file (already read as `existing`)
    // remains authoritative even when it carries extra top-level fields a
    // fresh build wouldn't reproduce. A manual-reconcile target is read-only,
    // so its existing bytes remain authoritative and are returned as-is.
    let effectiveConfig;
    if (targetAssessment.action === 'already-synced') {
      effectiveConfig = existing;
    } else if (manualReconciliation) {
      effectiveConfig = existing;
    } else {
      effectiveConfig = parsed.options.dryRun ? config : written.config;
    }

    const payload = {
      ok: true,
      action: manualReconciliation
        ? MANUAL_RECONCILIATION_ACTION
        : (parsed.options.dryRun ? 'dry-run' : (changed ? 'applied' : 'already-synced')),
      dryRun: Boolean(parsed.options.dryRun),
      changed,
      targetAction: manualReconciliation ? MANUAL_RECONCILIATION_ACTION : targetAssessment.action,
      manualReconciliation,
      workspace,
      vault: config.paths.vault,
      configPath,
      config: effectiveConfig,
      message: manualReconciliation
        ? manualReconciliationError(configPath).message
        : undefined,
      // Both retain compatibility and record that no config contents were
      // observed in the vault during this completed operation.
      vaultWrites: false,
      vaultContentsWritten: false,
    };
    process.stdout.write(parsed.options.json
      ? `${JSON.stringify(payload, null, 2)}\n`
      : `${renderSyncResult(payload)}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`jarvos sync failed: ${error.message}\n`);
    return 1;
  }
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
  let parsed;
  try {
    parsed = parseArgs(['init', ...argv]);
    if (parsed.help) {
      process.stdout.write(`${renderInitHelp()}\n`);
      return 0;
    }
    validateInitPathEnvironment(env);
    loadProfile(parsed.options.profile || 'minimal');
  } catch (error) {
    process.stderr.write(`jarvos init failed: ${error.message}\n`);
    return 1;
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

function normalizeArgvForInvocation(argv = [], invokedAs = process.argv[1]) {
  const invokedName = path.basename(invokedAs || '');
  if (!LEGACY_INIT_ALIASES.has(invokedName)) return argv;

  const first = argv[0];
  if (!first || first === '--help' || first === '-h' || !COMMANDS.has(first)) {
    return ['init', ...argv];
  }
  return argv;
}

async function runCli(argv = process.argv.slice(2), env = process.env, invokedAs = process.argv[1]) {
  const normalizedArgv = normalizeArgvForInvocation(argv, invokedAs);
  const parsed = parseArgs(normalizedArgv);
  if (parsed.command === 'help'
    || parsed.help && !['doctor', 'init', 'sync'].includes(parsed.command)) {
    process.stdout.write(`${renderHelp()}\n`);
    return 0;
  }

  if (parsed.command === 'init') {
    return runInit(normalizedArgv.slice(1), env);
  }

  if (parsed.command === 'sync') {
    return runSync(normalizedArgv.slice(1), env);
  }

  if (parsed.command === 'doctor') {
    if (parsed.help) {
      process.stdout.write(`${renderDoctorHelp()}\n`);
      return 0;
    }
    try {
      if (['local-openclaw', 'v0-5-0'].includes(parsed.options.profile)) {
        const profileDoctor = require('../modules/jarvos/src/doctor');
        const report = await profileDoctor.runProfileDoctor({
          profile: parsed.options.profile,
          workspace: parsed.options.workspace,
          openclawStateDir: parsed.options.openclawStateDir,
          stagedRuntimeRoot: parsed.options.stagedRuntimeRoot,
          configPath: parsed.options.config,
          env,
          homeDir: env.HOME || undefined,
        });
        if (parsed.options.json) {
          process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
        } else {
          process.stdout.write(`${profileDoctor.formatDoctorResult(report)}\n`);
        }
        return report.ok ? 0 : 1;
      }
      const report = runDoctor({ ...parsed.options, env, homeDir: env.HOME || undefined });
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
  assessControlPlaneDoctor,
  checkControlPlaneModule,
  checkCompoundEngineeringProvider,
  checkConfigReconciliation,
  checkJournalConflict,
  checkVaultPath,
  checkVaultPathStale,
  healthModuleBlocksDoctor,
  initPassthroughArgs,
  loadHealthModules,
  listProfiles,
  loadProfile,
  normalizeArgvForInvocation,
  parseArgs,
  renderDoctor,
  renderDoctorHelp,
  renderHelp,
  renderInitHelp,
  renderSyncHelp,
  resolveDoctorContext,
  runCli,
  runDoctor,
  runSync,
  assessDoctorConfigReconciliation,
  validateConfigShape,
  invalidRuntimeTimezoneAliases,
  schemaConfigWithRuntimeTimezoneAlias,
  selectedRuntimeTimezone,
};
