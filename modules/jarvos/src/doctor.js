'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const {
  buildInstallPlan,
  initJarvosWorkspace,
  loadPack,
} = require('../../jarvos-skills/src');
const {
  collectOpenClawPluginEvidence,
  inspectCompoundEngineeringProvider,
} = require('../../jarvos-runtime-kit/src');
const { loadHealthModules } = require('../../../lib/jarvos-doctor-modules');
const {
  assessDoctorConfigReconciliation,
  invalidRuntimeTimezoneAliases,
  schemaConfigWithRuntimeTimezoneAlias,
} = require('../../../lib/jarvos-cli');
const {
  expandTilde,
  isUsablePath,
  isValidTimezone,
  PATH_ENV_KEYS,
  resolveConfig,
  winningPathEnvKey,
} = require('../../jarvos-secondbrain/bridge/config/src/resolve-config');

// The keys resolveConfig() runs assertNotStaleVaultPath() against.  A
// config-only check that never consults the runtime's own resolver can
// report a stale ~/Documents/Vault v3 (or a canonical-vault-drift violation)
// healthy simply because the directory happens to exist with the right
// shape; the runtime itself would refuse to start from it.
const STALE_VAULT_GUARDED_PATH_KEYS = new Set(['vault', 'notes', 'journal']);

// Matches only assertNotStaleVaultPath()/assertWithinRequiredVault()'s own
// thrown messages. resolveConfig() throws for other reasons too (e.g. an
// invalid IANA timezone) while resolving the very same call; misattributing
// those to a vault/notes/journal path guard would blame the wrong check for
// a failure config.schema/timezone validation already owns.
const VAULT_PATH_GUARD_ERROR_PATTERN = /stale vault path|outside the required canonical vault/;

function isVaultPathGuardError(error) {
  return Boolean(error) && typeof error.message === 'string' && VAULT_PATH_GUARD_ERROR_PATTERN.test(error.message);
}

const MINIMAL_WORKSPACE_FILES = [
  'MEMORY.md',
  'jarvos.config.json',
  'jarvos.config.schema.json',
];

const REQUIRED_PATH_KEYS = [
  'workspace',
  'vault',
  'notes',
  'journal',
  'tags',
  'memory',
];

// These child directories are optional in portable configs: resolveConfig()
// derives them from a configured vault or workspace when absent.
const RESOLVER_DERIVED_PATH_KEYS = new Set([
  'notes', 'journal', 'tags', 'memory', 'scripts', 'workflows', 'customers',
]);

// What resolveConfig() actually does with a paths.* value it drops.  The two
// roots fall back to the home defaults; a dropped derived key is recomputed
// from whichever root it hangs off, which is not necessarily a home default.
const RELATIVE_PATH_FALLBACKS = {
  workspace: 'falls back to the home default workspace',
  vault: 'falls back to the home default vault',
  notes: 'recomputes it from the resolved vault',
  journal: 'recomputes it from the resolved vault',
  tags: 'recomputes it from the resolved vault',
  memory: 'recomputes it from the resolved workspace',
  scripts: 'recomputes it from the resolved workspace',
  workflows: 'recomputes it from the resolved workspace',
  customers: 'recomputes it from the resolved workspace',
};

const KNOWLEDGE_OUTPUT_FILES = [
  ['artifacts', 'directory'],
  ['gbrain-import-queue.json', 'file'],
  ['memory-wiki-queue.json', 'file'],
  ['qmd-refresh-pending.json', 'file'],
  ['lossless-continuity.json', 'file'],
];

const OBSIDIAN_CONFLICTING_WRITERS = [
  { id: 'journals', label: 'Journals community plugin' },
  { id: 'obsidian-journals', label: 'Journals community plugin' },
  { id: 'periodic-notes', label: 'Periodic Notes community plugin' },
  { id: 'templater-obsidian', label: 'Templater startup script' },
];

const GBRAIN_COMMAND_TIMEOUT_MS = 10_000;

function expandHome(value, homeDir = os.homedir()) {
  // Keep command-option expansion aligned with the shared runtime resolver,
  // including both ~/ and ~\\ roots, while retaining Doctor's threaded home.
  return expandTilde(value, homeDir);
}

function resolveConfiguredPath(value, workspace, homeDir = os.homedir()) {
  // normalizePathMap() trims paths.* before the runtime uses them, and
  // isUsablePath() gates on the trimmed string too.  Resolving the raw value
  // here would make a padded absolute path look relative and silently resolve
  // against the workspace, reporting a failure for a path the runtime uses fine.
  // expandTilde is the runtime's own helper, so `~\`-rooted values — which the
  // gate accepts — expand here exactly as resolveConfig() expands them. homeDir
  // must be the same home passed to resolveConfig()'s own cross-check below, or
  // a ~-rooted path resolves against a different home than the one the runtime
  // actually used, and the two computations spuriously diverge.
  const expanded = typeof value === 'string' ? expandTilde(value.trim(), homeDir) : expandHome(value, homeDir);
  if (typeof expanded !== 'string' || expanded === '') return expanded;
  return path.isAbsolute(expanded) ? expanded : path.resolve(workspace, expanded);
}

function fileExists(filePath) {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function directoryExists(dirPath) {
  try {
    return fs.statSync(dirPath).isDirectory();
  } catch {
    return false;
  }
}

function readJson(filePath) {
  try {
    return { ok: true, value: JSON.parse(fs.readFileSync(filePath, 'utf8')) };
  } catch (error) {
    return { ok: false, error };
  }
}

function typeMatches(value, type) {
  if (type === 'array') return Array.isArray(value);
  if (type === 'object') return value !== null && typeof value === 'object' && !Array.isArray(value);
  return typeof value === type;
}

function validateAgainstSchema(value, schema, instancePath = '') {
  const errors = [];

  if (!schema || typeof schema !== 'object') {
    return [`${instancePath || '/'} schema must be an object`];
  }

  if (Array.isArray(schema.anyOf)) {
    const matches = schema.anyOf.some((candidate) => (
      validateAgainstSchema(value, candidate, instancePath).length === 0
    ));
    if (!matches) {
      errors.push(`${instancePath || '/'} must match one supported config shape`);
    }
  }

  if (schema.type && !typeMatches(value, schema.type)) {
    errors.push(`${instancePath || '/'} must be ${schema.type}`);
    return errors;
  }

  if (schema.type === 'object') {
    const properties = schema.properties || {};
    const required = Array.isArray(schema.required) ? schema.required : [];

    for (const key of required) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) {
        errors.push(`${instancePath || '/'} must have required property ${key}`);
      }
    }

    for (const [key, childValue] of Object.entries(value)) {
      const childPath = `${instancePath}/${key}`;
      if (Object.prototype.hasOwnProperty.call(properties, key)) {
        errors.push(...validateAgainstSchema(childValue, properties[key], childPath));
      } else if (schema.additionalProperties === false) {
        errors.push(`${childPath} is not allowed`);
      } else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
        errors.push(...validateAgainstSchema(childValue, schema.additionalProperties, childPath));
      }
    }
  }

  if (schema.type === 'array' && schema.items) {
    value.forEach((item, index) => {
      errors.push(...validateAgainstSchema(item, schema.items, `${instancePath}/${index}`));
    });
  }

  if (schema.format === 'time-zone' && !isValidTimezone(value)) {
    errors.push(`${instancePath || '/'} must be a valid IANA timezone`);
  }
  if (schema.format === 'absolute-path' && !isUsablePath(value)) {
    errors.push(`${instancePath || '/'} must be an absolute or ~-rooted path the runtime can use`);
  }
  // Whitespace is not content; a whitespace-only required string is a failure.
  if (schema.type === 'string' && Number.isInteger(schema.minLength) && value.trim().length < schema.minLength) {
    errors.push(`${instancePath || '/'} must contain at least ${schema.minLength} non-whitespace character`);
  }

  return errors;
}

function createCheck(component, ok, message, details = {}) {
  return {
    component,
    ok,
    status: details.status || (ok ? 'ok' : 'fail'),
    message,
    ...details,
  };
}

function getPathConfig(config, key) {
  if (!config || typeof config !== 'object') return undefined;
  const paths = config.paths && typeof config.paths === 'object' ? config.paths : {};
  return Object.prototype.hasOwnProperty.call(paths, key) ? paths[key] : undefined;
}

/**
 * Resolve a configured paths.* value under the runtime's own contract.
 *
 * normalizePathMap() drops a relative or blank entry, so any consumer that
 * resolved one against the workspace would inspect a tree the runtime never
 * uses.  Returns null for anything the runtime would drop.
 *
 * Deliberately scoped to paths.*: adapter values such as
 * runtimeAdapters.openclaw.installedSkillsManifest are intentionally
 * workspace-relative and keep using resolveConfiguredPath().
 */
function runtimeConfiguredPath(config, key, homeDir = os.homedir()) {
  const value = getPathConfig(config, key);
  return isUsablePath(value, homeDir) ? expandTilde(value.trim(), homeDir) : null;
}

function resolveRuntimeConfigSnapshot(configPath, options = {}) {
  const homeDir = options.homeDir || os.homedir();
  const env = options.env || process.env;
  // This intentionally narrow seam keeps the snapshot test deterministic
  // without teaching the public Doctor report about resolver internals.
  const resolver = typeof options.runtimeConfigResolver === 'function'
    ? options.runtimeConfigResolver
    : resolveConfig;
  try {
    const runtimeConfig = resolver({ configPath, homeDir, env });
    const paths = runtimeConfig?.paths && typeof runtimeConfig.paths === 'object'
      ? Object.freeze({ ...runtimeConfig.paths })
      : null;
    return Object.freeze({ paths, error: null });
  } catch (error) {
    return Object.freeze({ paths: null, error });
  }
}

function validateConfiguredDirectory(workspace, config, key, configPath, options = {}, runtimeConfigSnapshot = null) {
  if (!config || typeof config !== 'object') {
    return createCheck(`path.${key}`, false, `Cannot inspect paths.${key} because jarvos.config.json is invalid`);
  }

  // homeDir is computed once and threaded through both the gate below and the
  // resolveConfig() cross-check further down, so a ~-rooted path and the
  // runtime's own resolution are always judged against the same home.
  const homeDir = options.homeDir || os.homedir();
  const value = getPathConfig(config, key);
  if (typeof value !== 'string' || value.trim() === '') {
    // Only a canonical portable config can use this omission. A legacy
    // config's fallback runtime paths are not evidence that its missing
    // paths.* contract is healthy.
    const portableRoots = config.paths && typeof config.paths === 'object'
      && config.user && typeof config.user === 'object'
      && isUsablePath(config.paths.workspace, homeDir)
      && isUsablePath(config.paths.vault, homeDir);
    if (!RESOLVER_DERIVED_PATH_KEYS.has(key) || !portableRoots) {
      return createCheck(`path.${key}`, false, `Missing configured path: paths.${key}`);
    }

    const snapshot = runtimeConfigSnapshot || (configPath
      ? resolveRuntimeConfigSnapshot(configPath, options)
      : null);
    const runtimeEffective = snapshot?.paths?.[key];
    if (!runtimeEffective) {
      return createCheck(`path.${key}`, false, `Missing configured path: paths.${key}`);
    }
    if (!directoryExists(runtimeEffective)) {
      return createCheck(
        `path.${key}`,
        false,
        `The runtime derives ${key} from its configured parent, but the effective directory is missing: ${runtimeEffective}`,
        { path: runtimeEffective },
      );
    }
    const env = options.env || process.env;
    const winningKey = winningPathEnvKey(PATH_ENV_KEYS[key] || [], env, homeDir);
    if (winningKey) {
      return createCheck(
        `path.${key}`,
        true,
        `Found ${key} directory via ${winningKey} environment override: ${runtimeEffective}`,
        { path: runtimeEffective, status: 'warn' },
      );
    }
    return createCheck(
      `path.${key}`,
      true,
      `Found runtime-derived ${key} directory: ${runtimeEffective}`,
      { path: runtimeEffective },
    );
  }
  // resolveConfiguredPath() resolves relative values against the workspace, but
  // normalizePathMap() drops them: workspace and vault then fall back to the
  // home defaults, and a dropped derived key is recomputed from its resolved
  // workspace/vault parent.  Either way the runtime never uses the configured
  // value, so reporting such a path healthy would hide that divergence.
  if (!isUsablePath(value, homeDir)) {
    return createCheck(
      `path.${key}`,
      false,
      `Configured path is not runtime-effective: paths.${key} must be absolute or ~-rooted (got ${value}); `
      + `the runtime ignores it and ${RELATIVE_PATH_FALLBACKS[key] || 'falls back to its default'}`,
    );
  }

  const resolvedPath = resolveConfiguredPath(value, workspace, homeDir);

  // Cross-check against the runtime's own resolver.  A runtime environment
  // override (JARVOS_*, or a legacy alias such as CLAWD_DIR/JOURNAL_DIR/
  // VAULT_NOTES_DIR — see PATH_ENV_KEYS) or the vault-drift/stale-vault guard
  // can make the runtime use a different directory than the one configured
  // here, or refuse to start from it outright; a check that only ever
  // inspects the configured value would report green for a directory the
  // runtime never touches, or for a vault resolveConfig() itself fails
  // closed on.
  if (configPath) {
    const env = options.env || process.env;
    // runMinimalDoctor resolves this once before entering the REQUIRED_PATH_KEYS
    // loop. Keep the fallback for internal callers that use this helper alone,
    // but never re-resolve inside an ordinary Doctor run: six reads could
    // otherwise produce a report assembled from six different configurations.
    const snapshot = runtimeConfigSnapshot || resolveRuntimeConfigSnapshot(configPath, options);
    const runtimePaths = snapshot.paths;
    const resolutionError = snapshot.error;
    if (resolutionError) {
      if (STALE_VAULT_GUARDED_PATH_KEYS.has(key) && isVaultPathGuardError(resolutionError)) {
        return createCheck(
          `path.${key}`,
          false,
          `The runtime's own resolver refuses this configuration, so paths.${key} cannot be reported `
          + `healthy: ${resolutionError.message}`,
        );
      }
      // Not a stale-vault/canonical-vault guard failure (or not one of the
      // guarded keys): the failure belongs to whichever check actually owns
      // it — e.g. an invalid timezone is config.schema's failure, not this
      // path's — so let this check proceed against the configured value.
    }

    if (runtimePaths) {
      const runtimeEffective = runtimePaths[key];
      if (runtimeEffective && path.resolve(runtimeEffective) !== path.resolve(resolvedPath)) {
        // `value` already passed isUsablePath() above, and validateConfigSchema()
        // read it from the same configPath resolveConfig() just re-read with the
        // same homeDir — so resolveConfig() computed configPaths[key] from the
        // identical value and it lands on the same resolvedPath this check did.
        // paths.*'s own vault/workspace fallback cascade only ever fires for a
        // key resolveConfig() found *unset* in both config and env, which this
        // key is not. So the only remaining way runtimePaths[key] can diverge
        // here is one of this key's own PATH_ENV_KEYS winning inside
        // firstEnvPath() — i.e. winningPathEnvKey() must report a concrete key.
        const winningKey = winningPathEnvKey(PATH_ENV_KEYS[key] || [], env, homeDir);
        if (!winningKey) {
          // The invariant above is broken: report it rather than mislabel the
          // cause, and fail closed instead of crashing the whole Doctor run.
          return createCheck(
            `path.${key}`,
            false,
            `paths.${key} configures ${resolvedPath}, but the runtime resolves it to `
            + `${runtimeEffective} for a reason Doctor cannot identify (no ${key} `
            + "environment override is set); resolveConfig()'s override precedence may have "
            + 'changed without this check being updated to match',
            { path: runtimeEffective },
          );
        }
        const overrideLabel = `a ${winningKey} environment override`;
        if (!directoryExists(runtimeEffective)) {
          return createCheck(
            `path.${key}`,
            false,
            `paths.${key} configures ${resolvedPath}, but ${overrideLabel} redirects the `
            + `runtime to ${runtimeEffective}, which does not exist`,
            { path: runtimeEffective },
          );
        }
        // The override directory exists, so the runtime is not broken — but
        // this is still drift between what jarvos.config.json says and what
        // actually runs, so it must stay visibly a warning, never plain ok.
        return createCheck(
          `path.${key}`,
          true,
          `Found ${key} directory via ${overrideLabel}: ${runtimeEffective} (paths.${key} configures ${resolvedPath})`,
          { path: runtimeEffective, status: 'warn' },
        );
      }
    }
  }

  if (!directoryExists(resolvedPath)) {
    return createCheck(`path.${key}`, false, `Missing configured ${key} directory: ${resolvedPath}`, {
      path: resolvedPath,
    });
  }

  return createCheck(`path.${key}`, true, `Found configured ${key} directory: ${resolvedPath}`, {
    path: resolvedPath,
  });
}

function createStatusCheck(component, status, message, details = {}) {
  return {
    component,
    ok: status !== 'fail',
    status,
    message,
    ...details,
  };
}

function gbrainContinuityCheck(workspace, config, options = {}) {
  const required = config?.gbrainContinuity?.required === true;
  const report = loadHealthModules({
    workspace,
    now: options.now || new Date(),
    expectedContinuity: required,
  });
  const continuity = report.modules.find((module) => module.id === 'gbrain-continuity');
  if (!continuity) return null;

  const healthy = continuity.state === 'healthy';
  const status = healthy ? 'ok' : (required ? 'fail' : 'warn');
  const targets = Array.isArray(continuity.targets)
    ? continuity.targets.map(({ target, evidenceState, reasonClass }) => ({ target, evidenceState, reasonClass }))
    : [];
  return createStatusCheck(
    'provider.gbrainContinuity',
    status,
    healthy
      ? 'GBrain continuity is live-turn proven for Codex, Hermes, and OpenClaw'
      : `GBrain continuity evidence needs attention (${continuity.reasonClass})`,
    { required, generation: continuity.generation, reasonClass: continuity.reasonClass, targets },
  );
}

function validateCompoundEngineeringProvider(options = {}) {
  const inspection = inspectCompoundEngineeringProvider({
    root: options.root,
    executable: options.codexExecutable,
    env: options.env,
    evidence: options.codexProviderEvidence,
  });
  const status = inspection.status || 'incompatible';
  const approved = inspection.capability?.approvedVersion || 'unknown';
  const active = inspection.discovery?.activeVersion || 'none';
  const message = status === 'healthy'
    ? `Compound Engineering ${active} is healthy for Codex`
    : `Compound Engineering provider is ${status} (approved ${approved}, discovered ${active})`;
  return createStatusCheck('provider.compound-engineering', status, message, {
    provider: inspection.capability?.id || 'compound-engineering',
    approvedVersion: approved,
    activeVersion: inspection.discovery?.activeVersion || null,
    admission: inspection.capability?.admission || null,
    recoveryAction: inspection.recoveryAction,
    reason: inspection.reason,
  });
}

function resolveDoctorConfigPath(workspace, options = {}) {
  const homeDir = options.homeDir || os.homedir();
  return path.resolve(expandHome(options.configPath || path.join(workspace, 'jarvos.config.json'), homeDir));
}

function resolveProfileDoctorContext(options = {}) {
  const env = options.env || process.env;
  const homeDir = options.homeDir || os.homedir();
  const workspaceInput = options.workspace || env.JARVOS_WORKSPACE_PATH || process.cwd();
  const workspace = path.resolve(expandHome(workspaceInput, homeDir));
  const configInput = options.configPath || env.JARVOS_CONFIG_PATH || path.join(workspace, 'jarvos.config.json');
  return {
    workspace,
    configPath: path.resolve(expandHome(configInput, homeDir)),
  };
}

function validateWorkspaceFiles(workspace, configPath = path.join(workspace, 'jarvos.config.json')) {
  const missing = MINIMAL_WORKSPACE_FILES.filter((relativePath) => {
    const filePath = relativePath === 'jarvos.config.json'
      ? configPath
      : path.join(workspace, relativePath);
    return !fileExists(filePath);
  });

  if (missing.length > 0) {
    return createCheck(
      'workspace.files',
      false,
      `Missing required workspace file(s): ${missing.join(', ')}`,
      { missing },
    );
  }

  return createCheck(
    'workspace.files',
    true,
    `Found required workspace file(s): ${MINIMAL_WORKSPACE_FILES.join(', ')}`,
  );
}

function validateAgentContext(workspace) {
  const agentPath = path.join(workspace, 'AGENTS.md');
  if (!fileExists(agentPath)) {
    return createCheck('agent.context', false, 'Missing agent context file: AGENTS.md', {
      missing: ['AGENTS.md'],
    });
  }

  const body = fs.readFileSync(agentPath, 'utf8').trim();
  if (!body) {
    return createCheck('agent.context', false, 'Agent context file is empty: AGENTS.md');
  }

  return createCheck('agent.context', true, 'Found agent context file: AGENTS.md');
}

function validateAgentContextHydration(workspace) {
  const agentPath = path.join(workspace, 'AGENTS.md');
  const memoryPath = path.join(workspace, 'MEMORY.md');
  const missing = [];
  const empty = [];

  for (const [label, filePath] of [
    ['AGENTS.md', agentPath],
    ['MEMORY.md', memoryPath],
  ]) {
    if (!fileExists(filePath)) {
      missing.push(label);
      continue;
    }

    if (!fs.readFileSync(filePath, 'utf8').trim()) {
      empty.push(label);
    }
  }

  if (missing.length || empty.length) {
    const parts = [];
    if (missing.length) parts.push(`missing: ${missing.join(', ')}`);
    if (empty.length) parts.push(`empty: ${empty.join(', ')}`);
    return createCheck('agent.context.hydration', false, `Agent context hydration is incomplete (${parts.join('; ')})`, {
      missing,
      empty,
    });
  }

  return createCheck('agent.context.hydration', true, 'Hydrated agent context from AGENTS.md and MEMORY.md', {
    files: ['AGENTS.md', 'MEMORY.md'],
  });
}

function validateConfigSchema(workspace, configPath = path.join(workspace, 'jarvos.config.json'), options = {}) {
  const schemaPath = path.join(workspace, 'jarvos.config.schema.json');

  const configResult = readJson(configPath);
  if (!configResult.ok) {
    return createCheck(
      'config.schema',
      false,
      `jarvos.config.json is not valid JSON: ${configResult.error.message}`,
    );
  }

  const schemaResult = readJson(schemaPath);
  if (!schemaResult.ok) {
    return createCheck(
      'config.schema',
      false,
      `jarvos.config.schema.json is not valid JSON: ${schemaResult.error.message}`,
    );
  }

  // Keep the schema check on the same env source as resolveConfig(). Passing
  // env: {} remains an explicit isolated environment rather than falling back
  // to process.env.
  const env = options.env || process.env;
  const errors = [
    ...validateAgainstSchema(schemaConfigWithRuntimeTimezoneAlias(configResult.value, env), schemaResult.value),
    ...invalidRuntimeTimezoneAliases(configResult.value, env)
      .map((field) => `/${field.replace('.', '/')} must be a valid IANA timezone`),
  ];

  if (errors.length > 0) {
    return createCheck(
      'config.schema',
      false,
      `jarvos.config.json failed jarvos.config.schema.json validation: ${errors.join('; ')}`,
      { errors },
    );
  }

  return createCheck('config.schema', true, 'jarvos.config.json validates against jarvos.config.schema.json', {
    config: configResult.value,
  });
}

function validateConfigReconciliation(config, configPath, options = {}) {
  const assessment = assessDoctorConfigReconciliation(config, configPath, options);
  if (assessment) {
    return createCheck(
      'config.reconciliation',
      false,
      assessment.detail,
      { action: assessment.action, configPath: assessment.configPath },
    );
  }
  return createCheck(
    'config.reconciliation',
    true,
    'No compatible legacy configuration requires a Doctor reconciliation recommendation',
  );
}

function defaultKnowledgeDirectory(workspace, config, options = {}) {
  // knowledge-optimizer.js and journal-spine-synthesis.js — the actual
  // runtime writers of knowledge output — give JARVOS_KNOWLEDGE_DIR absolute
  // priority over any vault-derived default, and never consult paths.knowledge
  // at all. They derive the default from their effective notes directory.
  // This must agree, or an output
  // directory that IS present (just wherever the env var actually points)
  // reads here as "not present yet".  A relative value is resolved the same
  // way the fs calls that follow it would resolve it: against cwd.
  const env = options.env || process.env;
  if (typeof env.JARVOS_KNOWLEDGE_DIR === 'string' && env.JARVOS_KNOWLEDGE_DIR.trim() !== '') {
    return path.resolve(env.JARVOS_KNOWLEDGE_DIR);
  }

  // runtimeObsidianPath uses the frozen resolveConfig() snapshot when one was
  // captured for this Doctor run. It deliberately ignores paths.knowledge:
  // that key is not an input to the writers above.
  const notesPath = runtimeObsidianPath(config, 'notes', options);
  if (notesPath) {
    const vaultRoot = path.basename(notesPath).toLowerCase() === 'notes' ? path.dirname(notesPath) : notesPath;
    return path.join(vaultRoot, '.jarvos', 'knowledge');
  }

  const vaultPath = runtimeObsidianPath(config, 'vault', options);
  if (vaultPath) return path.join(vaultPath, '.jarvos', 'knowledge');

  return path.join(workspace, '.jarvos', 'knowledge');
}

function validateMemoryWikiSurface(workspace, config, options = {}) {
  if (!config || typeof config !== 'object') {
    return createCheck('memory-wiki.surface', false, 'Cannot inspect memory-wiki surface because jarvos.config.json is invalid');
  }
  const runtimeError = options.runtimeConfigSnapshot?.error;
  if (runtimeError && isVaultPathGuardError(runtimeError)) {
    return createCheck(
      'memory-wiki.surface',
      true,
      `Skipped memory-wiki surface inspection because the runtime resolver refuses this vault configuration: ${runtimeError.message}`,
      { status: 'skipped' },
    );
  }

  const explicitMemoryWiki = getPathConfig(config, 'memoryWiki');
  if (typeof explicitMemoryWiki === 'string' && explicitMemoryWiki.trim()) {
    const memoryWikiPath = runtimeConfiguredPath(config, 'memoryWiki', options.homeDir);
    if (!memoryWikiPath) {
      return createCheck(
        'memory-wiki.surface',
        false,
        `Configured memory-wiki surface is not runtime-effective: paths.memoryWiki must be absolute or ~-rooted `
        + `(got ${explicitMemoryWiki}); the runtime ignores it`,
      );
    }
    if (directoryExists(memoryWikiPath) || fileExists(memoryWikiPath)) {
      return createCheck('memory-wiki.surface', true, `Found configured memory-wiki surface: ${memoryWikiPath}`, {
        path: memoryWikiPath,
      });
    }

    return createCheck('memory-wiki.surface', false, `Missing configured memory-wiki surface: ${memoryWikiPath}`, {
      path: memoryWikiPath,
    });
  }

  const knowledgeDir = defaultKnowledgeDirectory(workspace, config, options);
  const queuePath = path.join(knowledgeDir, 'memory-wiki-queue.json');
  if (fileExists(queuePath)) {
    return createCheck('memory-wiki.surface', true, `Found memory-wiki import queue: ${queuePath}`, {
      path: queuePath,
      knowledgeDir,
    });
  }

  return createCheck(
    'memory-wiki.surface',
    true,
    `Memory-wiki surface not present yet; skipped until a configured paths.memoryWiki or generated queue exists at ${queuePath}`,
    { status: 'skipped', path: queuePath, knowledgeDir },
  );
}

function validateKnowledgeOutputs(workspace, config, options = {}) {
  if (!config || typeof config !== 'object') {
    return createCheck('knowledge.outputs', false, 'Cannot inspect knowledge outputs because jarvos.config.json is invalid');
  }
  const runtimeError = options.runtimeConfigSnapshot?.error;
  if (runtimeError && isVaultPathGuardError(runtimeError)) {
    return createCheck(
      'knowledge.outputs',
      true,
      `Skipped knowledge output inspection because the runtime resolver refuses this vault configuration: ${runtimeError.message}`,
      { status: 'skipped' },
    );
  }

  const knowledgeDir = defaultKnowledgeDirectory(workspace, config, options);
  if (!directoryExists(knowledgeDir)) {
    return createCheck(
      'knowledge.outputs',
      true,
      `No jarvOS knowledge output directory yet; skipped until capture creates ${knowledgeDir}`,
      { status: 'skipped', path: knowledgeDir },
    );
  }

  const missing = [];
  for (const [relativePath, kind] of KNOWLEDGE_OUTPUT_FILES) {
    const candidate = path.join(knowledgeDir, relativePath);
    const exists = kind === 'directory' ? directoryExists(candidate) : fileExists(candidate);
    if (!exists) missing.push(relativePath);
  }

  if (missing.length) {
    return createCheck(
      'knowledge.outputs',
      false,
      `Incomplete jarvOS knowledge outputs in ${knowledgeDir}; missing: ${missing.join(', ')}`,
      { path: knowledgeDir, missing },
    );
  }

  return createCheck(
    'knowledge.outputs',
    true,
    `Found jarvOS reusable context outputs in ${knowledgeDir}`,
    {
      path: knowledgeDir,
      files: KNOWLEDGE_OUTPUT_FILES.map(([relativePath]) => relativePath),
    },
  );
}

function normalizePathForCompare(value, homeDir = os.homedir()) {
  if (typeof value !== 'string' || !value.trim()) return null;
  return path.resolve(expandHome(value, homeDir));
}

function samePath(a, b, homeDir = os.homedir()) {
  const left = normalizePathForCompare(a, homeDir);
  const right = normalizePathForCompare(b, homeDir);
  return Boolean(left && right && left === right);
}

function pathInside(parent, child, homeDir = os.homedir()) {
  const parentPath = normalizePathForCompare(parent, homeDir);
  const childPath = normalizePathForCompare(child, homeDir);
  if (!parentPath || !childPath) return false;
  const relative = path.relative(parentPath, childPath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function runtimeObsidianPath(config, key, options = {}) {
  const homeDir = options.homeDir || os.homedir();
  const env = options.env || process.env;
  const snapshotPaths = options.runtimeConfigSnapshot?.paths;
  if (!snapshotPaths) return runtimeConfiguredPath(config, key, homeDir);

  // A configured usable value or one of the runtime's own env overrides is
  // authoritative. Do not mistake a home-directory default for an active
  // jarvOS setting: a relative config value is deliberately ignored by the
  // runtime and should remain a per-key "not runtime-effective" diagnostic.
  if (winningPathEnvKey(PATH_ENV_KEYS[key] || [], env, homeDir) || runtimeConfiguredPath(config, key, homeDir)) {
    return snapshotPaths[key] || null;
  }

  // resolveConfig derives notes/journal from an explicitly selected vault.
  // This is the common portable shape with only paths.vault, and it must use
  // the same derived paths as the runtime rather than treating them as absent.
  const rawValue = getPathConfig(config, key);
  const vaultSelected = Boolean(
    winningPathEnvKey(PATH_ENV_KEYS.vault || [], env, homeDir)
    || runtimeConfiguredPath(config, 'vault', homeDir),
  );
  if ((key === 'notes' || key === 'journal') && rawValue === undefined && vaultSelected) {
    return snapshotPaths[key] || null;
  }
  return null;
}

function resolveObsidianVault(workspace, config, options = {}) {
  const explicit = normalizePathForCompare(options.obsidianVault, options.homeDir);
  if (explicit && directoryExists(path.join(explicit, '.obsidian'))) return explicit;

  const configuredVault = runtimeObsidianPath(config, 'vault', options);
  if (configuredVault && directoryExists(path.join(configuredVault, '.obsidian'))) return configuredVault;

  if (directoryExists(path.join(workspace, '.obsidian'))) return workspace;
  return null;
}

function readJsonValue(filePath, fallback) {
  const result = readJson(filePath);
  return result.ok ? result.value : fallback;
}

function enabledCorePlugins(obsidianDir) {
  const value = readJsonValue(path.join(obsidianDir, 'core-plugins.json'), []);
  if (Array.isArray(value)) return new Set(value);
  if (value && typeof value === 'object') {
    return new Set(Object.entries(value).filter(([, enabled]) => enabled).map(([name]) => name));
  }
  return new Set();
}

function enabledCommunityPlugins(obsidianDir) {
  const value = readJsonValue(path.join(obsidianDir, 'community-plugins.json'), []);
  return new Set(Array.isArray(value) ? value : []);
}

function hasTemplaterStartupScript(obsidianDir) {
  const dataPath = path.join(obsidianDir, 'plugins', 'templater-obsidian', 'data.json');
  const value = readJsonValue(dataPath, null);
  if (!value || typeof value !== 'object') return false;

  function walk(node, key = '') {
    if (Array.isArray(node)) return node.some((item) => walk(item, key));
    if (!node || typeof node !== 'object') {
      if (!String(key).toLowerCase().includes('startup')) return false;
      if (typeof node === 'boolean') return node;
      if (typeof node === 'string') return node.trim().length > 0;
      return Boolean(node);
    }
    return Object.entries(node).some(([childKey, childValue]) => walk(childValue, childKey));
  }

  return walk(value);
}

function validateObsidianSingleWriter(workspace, config, options = {}) {
  if (!config || typeof config !== 'object') {
    return createStatusCheck('obsidian.singleWriter', 'skipped', 'Cannot inspect Obsidian single-writer contract because jarvos.config.json is invalid');
  }

  const runtimeError = options.runtimeConfigSnapshot?.error;
  if (runtimeError && isVaultPathGuardError(runtimeError)) {
    return createStatusCheck(
      'obsidian.singleWriter',
      'warn',
      `Skipped Obsidian writer inspection because the runtime resolver refuses this vault configuration: ${runtimeError.message}`,
    );
  }

  const obsidianVault = resolveObsidianVault(workspace, config, options);
  if (!obsidianVault) {
    return createStatusCheck('obsidian.singleWriter', 'skipped', 'No active Obsidian vault config found; skipped automated daily-note writer check');
  }

  const obsidianDir = path.join(obsidianVault, '.obsidian');
  const corePlugins = enabledCorePlugins(obsidianDir);
  const communityPlugins = enabledCommunityPlugins(obsidianDir);
  const conflicts = [];

  if (corePlugins.has('daily-notes')) {
    conflicts.push({ id: 'daily-notes', label: 'Core Daily Notes plugin' });
  }

  for (const writer of OBSIDIAN_CONFLICTING_WRITERS) {
    if (!communityPlugins.has(writer.id)) continue;
    if (writer.id === 'templater-obsidian' && !hasTemplaterStartupScript(obsidianDir)) continue;
    conflicts.push(writer);
  }

  if (conflicts.length) {
    return createStatusCheck(
      'obsidian.singleWriter',
      'warn',
      `Obsidian can create daily journals independently; disable or de-scope: ${conflicts.map((conflict) => conflict.label).join(', ')}`,
      { path: obsidianVault, conflicts },
    );
  }

  return createStatusCheck('obsidian.singleWriter', 'ok', 'Obsidian config has no enabled automated daily-journal writers that conflict with jarvOS', {
    path: obsidianVault,
  });
}

function validateObsidianPaths(workspace, config, options = {}) {
  if (!config || typeof config !== 'object') {
    return createStatusCheck('obsidian.paths', 'skipped', 'Cannot validate Obsidian paths because jarvos.config.json is invalid');
  }

  const runtimeError = options.runtimeConfigSnapshot?.error;
  if (runtimeError && isVaultPathGuardError(runtimeError)) {
    return createStatusCheck(
      'obsidian.paths',
      'warn',
      `Skipped Obsidian path alignment because the runtime resolver refuses this vault configuration: ${runtimeError.message}`,
    );
  }

  const obsidianVault = resolveObsidianVault(workspace, config, options);
  if (!obsidianVault) {
    return createStatusCheck('obsidian.paths', 'skipped', 'No active Obsidian vault config found; skipped jarvOS vault path alignment check');
  }

  // Each key is judged on its own.  notes/journal are optional under the
  // schema, so an absent or unusable sibling must never suppress drift
  // reporting for a paths.vault the runtime would actually use.
  const stale = [];
  const skipped = [];
  const evaluate = (key, isAligned) => {
    const resolved = runtimeObsidianPath(config, key, options);
    if (!resolved) {
      skipped.push(getPathConfig(config, key) === undefined
        ? `paths.${key} is not configured`
        : `paths.${key} is not runtime-effective (must be absolute or ~-rooted)`);
      return;
    }
    const drift = isAligned(resolved);
    if (drift) stale.push(drift);
  };

  evaluate('vault', (resolved) => (samePath(resolved, obsidianVault) ? null : `paths.vault points at ${resolved}`));
  evaluate('journal', (resolved) => (pathInside(obsidianVault, resolved)
    ? null
    : `paths.journal points outside the active vault: ${resolved}`));
  evaluate('notes', (resolved) => (pathInside(obsidianVault, resolved)
    ? null
    : `paths.notes points outside the active vault: ${resolved}`));

  const details = { path: obsidianVault, ...(skipped.length ? { skipped } : {}) };
  if (stale.length) {
    return createStatusCheck(
      'obsidian.paths',
      'warn',
      `jarvos.config.json paths are stale for active Obsidian vault ${obsidianVault}: ${stale.join('; ')}`,
      { ...details, stale },
    );
  }

  if (skipped.length === 3) {
    return createStatusCheck(
      'obsidian.paths',
      'skipped',
      `Skipped jarvOS vault path alignment for active Obsidian vault ${obsidianVault}: ${skipped.join('; ')}`,
      details,
    );
  }

  const skippedNote = skipped.length ? ` (not evaluated: ${skipped.join('; ')})` : '';
  return createStatusCheck(
    'obsidian.paths',
    'ok',
    `jarvos.config.json paths align with active Obsidian vault: ${obsidianVault}${skippedNote}`,
    details,
  );
}

function runMinimalDoctor(options = {}) {
  const { workspace, configPath } = resolveProfileDoctorContext(options);
  const checks = [];

  if (!directoryExists(workspace)) {
    checks.push(createCheck('workspace.root', false, `Missing workspace directory: ${workspace}`, {
      path: workspace,
    }));
    return {
      profile: 'minimal',
      workspace,
      ok: false,
      status: 'failed',
      checks,
    };
  }

  checks.push(createCheck('workspace.root', true, `Found workspace directory: ${workspace}`, {
    path: workspace,
  }));
  checks.push(validateWorkspaceFiles(workspace, configPath));

  // Capture the runtime result exactly once. Every required-path check below
  // must describe the same runtime configuration (or the same guarded refusal)
  // even if the config changes while Doctor is rendering the report.
  const runtimeConfigSnapshot = resolveRuntimeConfigSnapshot(configPath, options);
  const runtimeOptions = { ...options, runtimeConfigSnapshot };

  const configSchemaCheck = validateConfigSchema(workspace, configPath, options);
  checks.push(configSchemaCheck);
  checks.push(validateConfigReconciliation(configSchemaCheck.config, configPath, options));
  for (const key of REQUIRED_PATH_KEYS) {
    checks.push(validateConfiguredDirectory(
      workspace,
      configSchemaCheck.config,
      key,
      configPath,
      options,
      runtimeConfigSnapshot,
    ));
  }
  checks.push(validateAgentContext(workspace));
  checks.push(validateAgentContextHydration(workspace));
  checks.push(validateMemoryWikiSurface(workspace, configSchemaCheck.config, runtimeOptions));
  checks.push(validateKnowledgeOutputs(workspace, configSchemaCheck.config, runtimeOptions));
  checks.push(validateObsidianSingleWriter(workspace, configSchemaCheck.config, runtimeOptions));
  checks.push(validateObsidianPaths(workspace, configSchemaCheck.config, runtimeOptions));
  checks.push(validateCompoundEngineeringProvider(options));
  const continuity = gbrainContinuityCheck(workspace, configSchemaCheck.config, options);
  if (continuity) checks.push(continuity);

  const ok = checks.every((check) => check.ok);
  return {
    profile: 'minimal',
    workspace,
    configPath,
    ok,
    status: ok ? 'ok' : 'failed',
    checks: checks.map(({ config, ...check }) => check),
  };
}

function normalizeProfile(profile = 'minimal') {
  if (profile === 'full-local') return 'local-openclaw';
  if (profile === 'v0.5.0') return 'v0-5-0';
  return profile;
}

function assertLocalOpenClawProfile(profile) {
  const normalized = normalizeProfile(profile);
  if (normalized !== 'local-openclaw') {
    if (normalized !== 'v0-5-0') {
      throw new Error(`Unknown init profile: ${profile}`);
    }
  }
  return normalized;
}

function profileNeedsOpenClawAdapter(profile) {
  return normalizeProfile(profile) === 'local-openclaw';
}

async function validateJarvosProfile(options = {}) {
  const { workspace, configPath } = resolveProfileDoctorContext(options);
  const profile = normalizeProfile(options.profile || 'minimal');
  const packName = options.packName || (profile === 'local-openclaw' ? 'local-openclaw' : 'v0-5-0');
  const checks = runMinimalDoctor({ ...options, workspace, configPath }).checks;
  const config = readWorkspaceConfig(workspace, configPath);
  const openclawStateDir = resolveOpenClawStateDir(options, config);
  const pack = loadPack(packName);
  const plan = buildInstallPlan({
    pack,
    homeDir: options.homeDir,
    workspaceRoot: workspace,
    openclawStateDir,
    commandsPresent: options.commandsPresent,
    filesPresent: options.filesPresent,
    providerVersions: options.providerVersions,
    providerStatuses: options.providerStatuses,
  });
  const hasOpenClawAdapter = Boolean(config && config.runtimeAdapters && config.runtimeAdapters.openclaw?.kind === 'openclaw');
  checks.push(...validateGbrainProvider(plan, options));
  if (profileNeedsOpenClawAdapter(profile)) {
    const openclawCommand = commandStatus(plan, 'openclaw');
    checks.push(openclawCommand?.present
      ? createStatusCheck('dependency.openclaw', 'ok', 'Found required OpenClaw command: openclaw')
      : createStatusCheck('dependency.openclaw', 'fail', 'Missing required OpenClaw command: openclaw', {
        installHint: openclawCommand?.installHint,
      }));

    const losslessCommand = commandStatus(plan, 'lossless-claw');
    checks.push(losslessCommand?.present
      ? createStatusCheck('dependency.lossless-claw', 'ok', 'Found optional continuity command: lossless-claw')
      : createStatusCheck('dependency.lossless-claw', 'skipped', 'Optional continuity command not installed: lossless-claw', {
        installHint: losslessCommand?.installHint,
      }));

    const stateDir = fileStatus(plan, 'openclaw-state-dir');
    checks.push(stateDir?.present
      ? createStatusCheck('openclaw.stateDir', 'ok', `Found OpenClaw state directory: ${stateDir.resolvedPath}`, {
        path: stateDir.resolvedPath,
      })
      : createStatusCheck('openclaw.stateDir', 'skipped', `OpenClaw state directory is not present yet: ${openclawStateDir}`, {
        path: stateDir?.resolvedPath || openclawStateDir,
      }));

    const runtimeConfig = fileStatus(plan, 'openclaw-runtime-config');
    checks.push(runtimeConfig?.present
      ? createStatusCheck('openclaw.runtimeConfig', 'ok', `Found existing OpenClaw runtime config: ${runtimeConfig.resolvedPath}`, {
        path: runtimeConfig.resolvedPath,
      })
      : createStatusCheck('openclaw.runtimeConfig', 'skipped', 'OpenClaw runtime config is absent; jarvOS init will not create or overwrite it', {
        path: runtimeConfig?.resolvedPath || path.join(openclawStateDir, 'openclaw.json'),
      }));
    checks.push(await validateOpenClawPluginPersistence(options, config, openclawCommand));
  }

  const hasPack = Boolean(config?.skillPacks?.installed?.includes(pack.name));
  checks.push(createStatusCheck(
    'jarvos.skillPack',
    hasPack ? 'ok' : 'warn',
    hasPack
      ? `Profile ${pack.name} is declared in skillPacks.installed`
      : `Profile ${pack.name} is not declared in skillPacks.installed`,
  ));

  const configuredManifest = hasOpenClawAdapter && config?.runtimeAdapters?.openclaw?.installedSkillsManifest;
  const installedSkillsManifestPath = configuredManifest
    ? resolveConfiguredPath(configuredManifest, workspace, options.homeDir)
    : defaultInstalledSkillsManifestPath(workspace, profile);
  checks.push(fileExists(installedSkillsManifestPath)
    ? createStatusCheck('jarvos.installedSkills', 'ok', `Found installed skills manifest: ${installedSkillsManifestPath}`, {
      path: installedSkillsManifestPath,
    })
    : createStatusCheck('jarvos.installedSkills', 'skipped', `Installed skills manifest not created yet: ${installedSkillsManifestPath}`, {
      path: installedSkillsManifestPath,
    }));

  if (!profileNeedsOpenClawAdapter(profile) && hasOpenClawAdapter) {
    checks.push(createStatusCheck('jarvos.openclawAdapter', 'warn', 'OpenClaw adapter is present; this profile keeps it optional', {
      hasOpenClawAdapter,
    }));
  } else if (profileNeedsOpenClawAdapter(profile)) {
    checks.push(hasOpenClawAdapter
      ? createStatusCheck('jarvos.openclawAdapter', 'ok', 'jarvos.config.json registers OpenClaw as a runtime adapter')
      : createStatusCheck('jarvos.openclawAdapter', 'skipped', 'OpenClaw adapter is not registered yet; run jarvos init --profile local-openclaw'));
  }

  const workspaceStatePath = fileStatus(plan, 'openclaw-state-dir')
    ? path.join(fileStatus(plan, 'openclaw-state-dir').resolvedPath, 'workspace-state.json')
    : path.join(workspace, '.jarvos', 'workspace-state.json');
  checks.push(fileExists(workspaceStatePath)
    ? createStatusCheck('jarvos.workspaceState', 'ok', `Found jarvOS workspace state: ${workspaceStatePath}`, {
      path: workspaceStatePath,
    })
    : createStatusCheck('jarvos.workspaceState', 'skipped', `jarvOS workspace state not created yet: ${workspaceStatePath}`, {
      path: workspaceStatePath,
    }));

  const failed = checks.some((check) => check.status === 'fail');
  const skipped = checks.some((check) => check.status === 'skipped');
  return {
    profile,
    workspace,
    ok: !failed,
    status: failed ? 'failed' : (skipped ? 'partial' : 'ok'),
    planStatus: plan.status,
    missingRequiredCommands: plan.missingRequiredCommands,
    missingOptionalCommands: plan.missingOptionalCommands,
    checks,
  };
}

function validateGbrainProvider(plan, options = {}) {
  const provider = (plan.providers || []).find((entry) => entry.name === 'gbrain');
  if (!provider) return [];

  const checks = [];
  if (provider.status === 'missing') {
    checks.push(createStatusCheck(
      'provider.gbrain',
      'warn',
      `Optional GBrain provider is not installed; expected ${provider.minimumVersion}+ for brain-native memory and skillpack validation`,
      {
        required: false,
        command: provider.command,
        minimumVersion: provider.minimumVersion,
        installHint: provider.installHint,
      },
    ));
    checks.push(...gbrainRuntimeConnectionChecks(provider, options));
    return checks;
  }

  if (provider.versionStatus === 'stale') {
    checks.push(createStatusCheck(
      'provider.gbrain',
      'warn',
      `GBrain provider is stale: installed ${provider.installedVersion}, expected ${provider.minimumVersion}+`,
      {
        required: false,
        command: provider.command,
        installedVersion: provider.installedVersion,
        minimumVersion: provider.minimumVersion,
        installHint: provider.installHint,
      },
    ));
  } else if (provider.versionStatus === 'unknown') {
    checks.push(createStatusCheck(
      'provider.gbrain',
      'warn',
      `GBrain provider command is present, but jarvOS could not determine its version`,
      {
        required: false,
        command: provider.command,
        minimumVersion: provider.minimumVersion,
      },
    ));
  } else {
    checks.push(createStatusCheck(
      'provider.gbrain',
      'ok',
      `GBrain provider is available: ${provider.installedVersion}`,
      {
        command: provider.command,
        installedVersion: provider.installedVersion,
        minimumVersion: provider.minimumVersion,
        capabilities: provider.capabilities,
      },
    ));
  }

  checks.push(validateGbrainJsonCommand(
    provider,
    'provider.gbrain.status',
    ['status', '--fast', '--json'],
    'status',
    options,
    (value) => {
      const primarySource = Array.isArray(value?.sync?.sources) ? value.sync.sources[0] : null;
      const pages = value?.pages ?? value?.counts?.pages ?? value?.stats?.pages ?? primarySource?.pages;
      const chunks = value?.chunks_total ?? value?.chunks?.total ?? value?.stats?.chunks_total ?? primarySource?.chunks_total;
      const coverage = value?.embedding_coverage_pct ?? value?.embeddings?.coverage_pct ?? primarySource?.embedding_coverage_pct;
      const parts = ['GBrain status --fast is available'];
      if (pages !== undefined) parts.push(`${pages} pages`);
      if (chunks !== undefined) parts.push(`${chunks} chunks`);
      if (coverage !== undefined) parts.push(`${coverage}% embedding coverage`);
      return {
        message: parts.join('; '),
        details: {
          pages,
          chunks,
          embeddingCoveragePct: coverage,
          mode: value?.mode,
        },
      };
    },
  ));
  checks.push(validateGbrainJsonCommand(
    provider,
    'provider.gbrain.advisor',
    ['advisor', '--json'],
    'advisor',
    options,
    (value) => {
      const findings = Array.isArray(value?.findings) ? value.findings : [];
      const worstSeverity = value?.worstSeverity || value?.worst_severity || findings[0]?.severity || 'info';
      return {
        message: `GBrain advisor is available; worst severity: ${worstSeverity}`,
        details: {
          worstSeverity,
          findingCount: findings.length,
          askUserCount: findings.filter((finding) => finding?.ask_user === true || finding?.askUser === true).length,
        },
      };
    },
  ));
  checks.push(...gbrainRuntimeConnectionChecks(provider, options));
  return checks;
}

function validateGbrainJsonCommand(provider, component, args, resultKey, options, summarize) {
  if (provider.status === 'missing') {
    return createStatusCheck(component, 'skipped', `Skipped ${component} because GBrain is not installed`);
  }

  const commandResult = options.gbrainCommandResults?.[resultKey] || runCommand(provider.command || 'gbrain', args, options);
  if (commandResult.status !== 0) {
    return createStatusCheck(component, 'warn', `GBrain ${args[0]} check is unavailable`, {
      statusCode: commandResult.status,
      signal: commandResult.signal,
      timedOut: commandResult.timedOut,
      error: commandResult.error,
    });
  }

  const parsed = parseJson(commandResult.stdout);
  if (!parsed.ok) {
    return createStatusCheck(component, 'warn', `GBrain ${args[0]} returned non-JSON output`, {
      parseError: parsed.error,
    });
  }

  const summary = summarize(parsed.value);
  return createStatusCheck(component, 'ok', summary.message, summary.details);
}

function runCommand(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    timeout: options.gbrainCommandTimeoutMs || GBRAIN_COMMAND_TIMEOUT_MS,
  });
  return {
    status: result.status,
    signal: result.signal,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    error: result.error ? result.error.message : null,
    timedOut: result.error?.code === 'ETIMEDOUT',
  };
}

function parseJson(value) {
  try {
    return { ok: true, value: JSON.parse(value || '{}') };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

function gbrainRuntimeConnectionChecks(provider, options = {}) {
  const explicitConnections = options.gbrainRuntimeConnections || {};
  return (provider.runtimeTargets || []).map((target) => {
    const state = explicitConnections[target] || 'unknown';
    if (state === true || state === 'connected') {
      return createStatusCheck(
        `provider.gbrain.runtime.${target}`,
        'ok',
        `GBrain MCP connection is configured for ${target}`,
        { target, connection: 'connected' },
      );
    }
    if (state === false || state === 'missing') {
      return createStatusCheck(
        `provider.gbrain.runtime.${target}`,
        'warn',
        `GBrain MCP connection is missing for ${target}`,
        { target, connection: 'missing' },
      );
    }
    return createStatusCheck(
      `provider.gbrain.runtime.${target}`,
      'skipped',
      `GBrain MCP connection for ${target} has not been inspected yet`,
      { target, connection: 'unknown' },
    );
  });
}

function commandStatus(plan, name) {
  return (plan.environment.commands || []).find((command) => command.name === name);
}

function fileStatus(plan, name) {
  return (plan.environment.files || []).find((file) => file.name === name);
}

function defaultInstalledSkillsManifestPath(workspace, profile) {
  return path.join(workspace, '.jarvos', 'installed-skills', `${profile}.json`);
}

function resolveOpenClawStateDir(options = {}, config) {
  const env = options.env || process.env;
  const homeDir = options.homeDir || os.homedir();
  const configured = config?.runtimeAdapters?.openclaw?.stateDir;
  const envConfigPath = env.OPENCLAW_CONFIG_PATH;
  const envStateDir = typeof envConfigPath === 'string' && envConfigPath.trim()
    ? path.dirname(expandHome(envConfigPath, homeDir))
    : null;
  return path.resolve(expandHome(
    options.openclawStateDir || configured || envStateDir || path.join(homeDir, '.openclaw'),
    homeDir,
  ));
}

function resolveStagedOpenClawRuntimeRoot(options = {}, config) {
  const env = options.env || process.env;
  const homeDir = options.homeDir || os.homedir();
  const configured = config?.runtimeAdapters?.openclaw?.stagedRuntimeRoot;
  return path.resolve(expandHome(
    options.stagedRuntimeRoot
      || configured
      || env.JARVOS_STAGED_PUBLIC_RUNTIME_ROOT
      || path.join(__dirname, '..', '..', '..'),
    homeDir,
  ));
}

function stagedOpenClawAdapterEvidence(options = {}, config) {
  const runtimeDir = path.join(resolveStagedOpenClawRuntimeRoot(options, config), 'runtimes', 'openclaw');
  return {
    path: path.join(runtimeDir, 'jarvos-next-turn-plugin.js'),
    exists: fileExists(path.join(runtimeDir, 'jarvos-next-turn-plugin.js')),
    manifestExists: fileExists(path.join(runtimeDir, 'openclaw.plugin.json'))
      && fileExists(path.join(runtimeDir, 'package.json')),
  };
}

function persistenceSummaryDetails(result) {
  const summary = result && typeof result.summary === 'object' ? result.summary : {};
  const boundedCount = (value) => Number.isInteger(value) && value >= 0 && value <= 100000 ? value : 0;
  return {
    pluginCount: boundedCount(summary.pluginCount),
    protectedRootCount: boundedCount(summary.protectedRootCount),
    driftCount: boundedCount(summary.driftCount),
    evidenceVersion: result?.evidence?.version === '2026.7.1' ? '2026.7.1' : 'unknown',
    recoveryCommands: [
      'openclaw plugins inspect --all --json',
      'openclaw plugins list --json',
      'openclaw plugins doctor',
      'openclaw plugins install <approved-spec>',
      'openclaw plugins update <id>',
    ],
  };
}

function mapOpenClawPersistenceResult(result) {
  if (!result || result.status === 'compatibility') {
    return createStatusCheck(
      'openclaw.pluginPersistence',
      'skipped',
      'OpenClaw plugin persistence check skipped because supported structured CLI evidence is unavailable',
      { reason: 'compatibility', ...persistenceSummaryDetails(result) },
    );
  }

  const details = persistenceSummaryDetails(result);
  if (result.jarvosAdapter?.status === 'missing-staged-adapter') {
    return createStatusCheck(
      'openclaw.pluginPersistence',
      'fail',
      'jarvOS staged OpenClaw adapter is missing; rerun the supported local-openclaw setup',
      { reason: 'missing-staged-adapter', ...details },
    );
  }

  if (result.status === 'indeterminate') {
    return createStatusCheck(
      'openclaw.pluginPersistence',
      'warn',
      'OpenClaw plugin persistence is indeterminate because its evidence was incomplete or changed during inspection',
      { reason: 'indeterminate', ...details },
    );
  }

  if (result.status === 'warn') {
    return createStatusCheck(
      'openclaw.pluginPersistence',
      'warn',
      'OpenClaw plugin persistence drift detected; review the supported OpenClaw commands before recovery',
      { reason: 'plugin-drift', ...details },
    );
  }

  if (result.status === 'ok') {
    return createStatusCheck(
      'openclaw.pluginPersistence',
      'ok',
      'OpenClaw managed plugin persistence is healthy',
      { reason: 'healthy', ...details },
    );
  }

  return createStatusCheck(
    'openclaw.pluginPersistence',
    'warn',
    'OpenClaw plugin persistence could not be classified safely',
    { reason: 'unknown-result', ...details },
  );
}

async function validateOpenClawPluginPersistence(options = {}, config, command) {
  if (!options.openclawPluginEvidence && command && command.present === false) {
    return createStatusCheck(
      'openclaw.pluginPersistence',
      'skipped',
      'OpenClaw plugin persistence check skipped because the OpenClaw command is not installed',
      { reason: 'command-missing', recoveryCommands: ['Install OpenClaw, then rerun jarvos doctor'] },
    );
  }

  const evidence = options.openclawPluginEvidence || await collectOpenClawPluginEvidence({
    executable: options.openclawCommand || 'openclaw',
    timeoutMs: options.openclawPluginTimeoutMs,
    outputLimit: options.openclawPluginOutputLimit,
    filesystem: {
      exists: (filePath) => fileExists(filePath) || directoryExists(filePath),
      isFile: (filePath) => fileExists(filePath),
    },
    stagedAdapter: stagedOpenClawAdapterEvidence(options, config),
  });
  return mapOpenClawPersistenceResult(evidence);
}

function readWorkspaceConfig(workspace, configPath = path.join(workspace, 'jarvos.config.json')) {
  const result = readJson(configPath);
  return result.ok ? result.value : null;
}

async function validateOpenClawProfile(options = {}) {
  const { workspace, configPath } = resolveProfileDoctorContext(options);
  const profile = normalizeProfile(options.profile || 'local-openclaw');
  const checks = runMinimalDoctor({ ...options, workspace, configPath }).checks;
  const config = readWorkspaceConfig(workspace, configPath);
  const openclawStateDir = resolveOpenClawStateDir(options, config);
  const pack = loadPack('local-openclaw');
  const plan = buildInstallPlan({
    pack,
    homeDir: options.homeDir,
    workspaceRoot: workspace,
    openclawStateDir,
    commandsPresent: options.commandsPresent,
    filesPresent: options.filesPresent,
    providerVersions: options.providerVersions,
    providerStatuses: options.providerStatuses,
  });

  const openclawCommand = commandStatus(plan, 'openclaw');
  checks.push(openclawCommand?.present
    ? createStatusCheck('dependency.openclaw', 'ok', 'Found required OpenClaw command: openclaw')
    : createStatusCheck('dependency.openclaw', 'fail', 'Missing required OpenClaw command: openclaw', {
      installHint: openclawCommand?.installHint,
    }));

  const losslessCommand = commandStatus(plan, 'lossless-claw');
  checks.push(losslessCommand?.present
    ? createStatusCheck('dependency.lossless-claw', 'ok', 'Found optional continuity command: lossless-claw')
    : createStatusCheck('dependency.lossless-claw', 'skipped', 'Optional continuity command not installed: lossless-claw', {
      installHint: losslessCommand?.installHint,
    }));

  const stateDir = fileStatus(plan, 'openclaw-state-dir');
  checks.push(stateDir?.present
    ? createStatusCheck('openclaw.stateDir', 'ok', `Found OpenClaw state directory: ${stateDir.resolvedPath}`, {
      path: stateDir.resolvedPath,
    })
    : createStatusCheck('openclaw.stateDir', 'skipped', `OpenClaw state directory is not present yet: ${openclawStateDir}`, {
      path: openclawStateDir,
    }));

  const runtimeConfig = fileStatus(plan, 'openclaw-runtime-config');
  checks.push(runtimeConfig?.present
    ? createStatusCheck('openclaw.runtimeConfig', 'ok', `Found existing OpenClaw runtime config: ${runtimeConfig.resolvedPath}`, {
      path: runtimeConfig.resolvedPath,
    })
    : createStatusCheck('openclaw.runtimeConfig', 'skipped', 'OpenClaw runtime config is absent; jarvOS init will not create or overwrite it', {
      path: runtimeConfig?.resolvedPath || path.join(openclawStateDir, 'openclaw.json'),
    }));
  checks.push(await validateOpenClawPluginPersistence(options, config, openclawCommand));

  const adapter = config?.runtimeAdapters?.openclaw;
  checks.push(adapter?.kind === 'openclaw'
    ? createStatusCheck('jarvos.openclawAdapter', 'ok', 'jarvos.config.json registers OpenClaw as a runtime adapter')
    : createStatusCheck('jarvos.openclawAdapter', 'skipped', 'OpenClaw adapter is not registered yet; run jarvos init --profile local-openclaw'));

  const workspaceStatePath = path.join(openclawStateDir, 'workspace-state.json');
  checks.push(fileExists(workspaceStatePath)
    ? createStatusCheck('jarvos.workspaceState', 'ok', `Found jarvOS workspace state: ${workspaceStatePath}`, {
      path: workspaceStatePath,
    })
    : createStatusCheck('jarvos.workspaceState', 'skipped', `jarvOS workspace state not created yet: ${workspaceStatePath}`, {
      path: workspaceStatePath,
    }));

  const configuredManifest = adapter?.installedSkillsManifest;
  const installedSkillsManifestPath = configuredManifest
    ? resolveConfiguredPath(configuredManifest, workspace, options.homeDir)
    : defaultInstalledSkillsManifestPath(workspace, profile);
  checks.push(fileExists(installedSkillsManifestPath)
    ? createStatusCheck('jarvos.installedSkills', 'ok', `Found installed skills manifest: ${installedSkillsManifestPath}`, {
      path: installedSkillsManifestPath,
    })
    : createStatusCheck('jarvos.installedSkills', 'skipped', `Installed skills manifest not created yet: ${installedSkillsManifestPath}`, {
      path: installedSkillsManifestPath,
    }));

  const failed = checks.some((check) => check.status === 'fail');
  const skipped = checks.some((check) => check.status === 'skipped');
  return {
    profile,
    workspace,
    ok: !failed,
    status: failed ? 'failed' : (skipped ? 'partial' : 'ok'),
    planStatus: plan.status,
    missingRequiredCommands: plan.missingRequiredCommands,
    missingOptionalCommands: plan.missingOptionalCommands,
    checks,
  };
}

async function runProfileDoctor(options = {}) {
  const profile = normalizeProfile(options.profile || 'minimal');
  if (profile === 'minimal') {
    return runMinimalDoctor(options);
  }
  if (profile === 'local-openclaw' || profile === 'v0-5-0') {
    return validateJarvosProfile({ ...options, profile });
  }
  throw new Error(`Unknown doctor profile: ${options.profile}`);
}

function writeTextIfMissing(filePath, body) {
  if (fs.existsSync(filePath)) return 'preserved';
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, body);
  return 'created';
}

function ensurePortableWorkspaceFiles(workspace) {
  const schemaSource = path.resolve(__dirname, '..', '..', 'jarvos.config.schema.json');
  const schemaTarget = path.join(workspace, 'jarvos.config.schema.json');
  const writes = {
    agents: writeTextIfMissing(
      path.join(workspace, 'AGENTS.md'),
      '# AGENTS.md\n\njarvOS workspace context. Add local operating rules here.\n',
    ),
    memory: writeTextIfMissing(
      path.join(workspace, 'MEMORY.md'),
      '# MEMORY.md\n\nStable user, project, and preference memory belongs here.\n',
    ),
    configSchema: 'missing-source',
  };

  if (fileExists(schemaSource)) {
    writes.configSchema = fs.existsSync(schemaTarget) ? 'preserved' : 'created';
    if (writes.configSchema === 'created') {
      fs.copyFileSync(schemaSource, schemaTarget);
    }
  }

  return writes;
}

async function initProfile(options = {}) {
  const profile = assertLocalOpenClawProfile(options.profile || 'local-openclaw');
  const packName = profile === 'local-openclaw' ? 'local-openclaw' : 'v0-5-0';
  const result = initJarvosWorkspace({
    packName,
    workspaceRoot: options.workspace,
    openclawStateDir: options.openclawStateDir,
    configPath: options.configPath,
    commandsPresent: options.commandsPresent,
    filesPresent: options.filesPresent,
    homeDir: options.homeDir,
    providerVersions: options.providerVersions,
    providerStatuses: options.providerStatuses,
  });
  const portableWorkspaceWrites = ensurePortableWorkspaceFiles(result.workspaceRoot);
  const doctor = await runProfileDoctor({
    profile,
    workspace: result.workspaceRoot,
    configPath: options.configPath,
    env: options.env,
    openclawStateDir: result.openclawStateDir,
    commandsPresent: options.commandsPresent,
    filesPresent: options.filesPresent,
    homeDir: options.homeDir,
    providerVersions: options.providerVersions,
    providerStatuses: options.providerStatuses,
    gbrainCommandResults: options.gbrainCommandResults,
    gbrainRuntimeConnections: options.gbrainRuntimeConnections,
    gbrainCommandTimeoutMs: options.gbrainCommandTimeoutMs,
    openclawPluginEvidence: options.openclawPluginEvidence,
    openclawPluginTimeoutMs: options.openclawPluginTimeoutMs,
    openclawPluginOutputLimit: options.openclawPluginOutputLimit,
    stagedRuntimeRoot: options.stagedRuntimeRoot,
  });

  return {
    ...result,
    profile,
    runtimeConfig: result.writes?.runtimeConfig,
    writes: {
      ...result.writes,
      portableWorkspace: portableWorkspaceWrites,
    },
    doctor,
  };
}

function formatDoctorResult(result) {
  const lines = [
    `jarvOS doctor (${result.profile})`,
    `Workspace: ${result.workspace}`,
    `Status: ${result.status}`,
    '',
  ];

  for (const check of result.checks) {
    const marker = check.status || (check.ok ? 'ok' : 'fail');
    lines.push(`[${marker}] ${check.component}: ${check.message}`);
  }

  return `${lines.join('\n')}\n`;
}

module.exports = {
  MINIMAL_WORKSPACE_FILES,
  formatDoctorResult,
  defaultKnowledgeDirectory,
  initProfile,
  mapOpenClawPersistenceResult,
  runProfileDoctor,
  runMinimalDoctor,
  resolveOpenClawStateDir,
  resolveStagedOpenClawRuntimeRoot,
  validateJarvosProfile,
  validateOpenClawProfile,
  validateObsidianPaths,
  validateObsidianSingleWriter,
  validateCompoundEngineeringProvider,
  validateConfigReconciliation,
};
