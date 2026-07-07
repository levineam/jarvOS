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
  'memory',
];

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

function expandHome(value) {
  if (typeof value !== 'string') return value;
  if (value === '~') return os.homedir();
  if (value.startsWith('~/')) return path.join(os.homedir(), value.slice(2));
  return value;
}

function resolveConfiguredPath(value, workspace) {
  const expanded = expandHome(value);
  if (typeof expanded !== 'string' || expanded.trim() === '') return expanded;
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

  if (schema.type && !typeMatches(value, schema.type)) {
    errors.push(`${instancePath || '/'} must be ${schema.type}`);
    return errors;
  }

  if (schema.type === 'object' && schema.properties) {
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
  if (!config.paths || typeof config.paths !== 'object') return undefined;
  return config.paths[key];
}

function validateConfiguredDirectory(workspace, config, key) {
  if (!config || typeof config !== 'object') {
    return createCheck(`path.${key}`, false, `Cannot inspect paths.${key} because jarvos.config.json is invalid`);
  }

  const value = getPathConfig(config, key);
  if (typeof value !== 'string' || value.trim() === '') {
    return createCheck(`path.${key}`, false, `Missing configured path: paths.${key}`);
  }

  const resolvedPath = resolveConfiguredPath(value, workspace);
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

function validateWorkspaceFiles(workspace) {
  const missing = MINIMAL_WORKSPACE_FILES.filter((relativePath) => {
    return !fileExists(path.join(workspace, relativePath));
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

function validateConfigSchema(workspace) {
  const configPath = path.join(workspace, 'jarvos.config.json');
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

  const errors = validateAgainstSchema(configResult.value, schemaResult.value);

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

function defaultKnowledgeDirectory(workspace, config) {
  const explicitKnowledge = getPathConfig(config, 'knowledge');
  if (typeof explicitKnowledge === 'string' && explicitKnowledge.trim()) {
    return resolveConfiguredPath(explicitKnowledge, workspace);
  }

  const vaultValue = getPathConfig(config, 'vault');
  if (typeof vaultValue === 'string' && vaultValue.trim()) {
    return path.join(resolveConfiguredPath(vaultValue, workspace), '.jarvos', 'knowledge');
  }

  const notesValue = getPathConfig(config, 'notes');
  if (typeof notesValue === 'string' && notesValue.trim()) {
    const notesPath = resolveConfiguredPath(notesValue, workspace);
    const vaultPath = path.basename(notesPath).toLowerCase() === 'notes' ? path.dirname(notesPath) : notesPath;
    return path.join(vaultPath, '.jarvos', 'knowledge');
  }

  return path.join(workspace, '.jarvos', 'knowledge');
}

function validateMemoryWikiSurface(workspace, config) {
  if (!config || typeof config !== 'object') {
    return createCheck('memory-wiki.surface', false, 'Cannot inspect memory-wiki surface because jarvos.config.json is invalid');
  }

  const explicitMemoryWiki = getPathConfig(config, 'memoryWiki');
  if (typeof explicitMemoryWiki === 'string' && explicitMemoryWiki.trim()) {
    const memoryWikiPath = resolveConfiguredPath(explicitMemoryWiki, workspace);
    if (directoryExists(memoryWikiPath) || fileExists(memoryWikiPath)) {
      return createCheck('memory-wiki.surface', true, `Found configured memory-wiki surface: ${memoryWikiPath}`, {
        path: memoryWikiPath,
      });
    }

    return createCheck('memory-wiki.surface', false, `Missing configured memory-wiki surface: ${memoryWikiPath}`, {
      path: memoryWikiPath,
    });
  }

  const knowledgeDir = defaultKnowledgeDirectory(workspace, config);
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

function validateKnowledgeOutputs(workspace, config) {
  if (!config || typeof config !== 'object') {
    return createCheck('knowledge.outputs', false, 'Cannot inspect knowledge outputs because jarvos.config.json is invalid');
  }

  const knowledgeDir = defaultKnowledgeDirectory(workspace, config);
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

function normalizePathForCompare(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  return path.resolve(expandHome(value));
}

function samePath(a, b) {
  const left = normalizePathForCompare(a);
  const right = normalizePathForCompare(b);
  return Boolean(left && right && left === right);
}

function pathInside(parent, child) {
  const parentPath = normalizePathForCompare(parent);
  const childPath = normalizePathForCompare(child);
  if (!parentPath || !childPath) return false;
  const relative = path.relative(parentPath, childPath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function resolveObsidianVault(workspace, config, options = {}) {
  const explicit = normalizePathForCompare(options.obsidianVault);
  if (explicit && directoryExists(path.join(explicit, '.obsidian'))) return explicit;

  const configuredVault = resolveConfiguredPath(getPathConfig(config, 'vault'), workspace);
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

  const obsidianVault = resolveObsidianVault(workspace, config, options);
  if (!obsidianVault) {
    return createStatusCheck('obsidian.paths', 'skipped', 'No active Obsidian vault config found; skipped jarvOS vault path alignment check');
  }

  const configuredVault = resolveConfiguredPath(getPathConfig(config, 'vault'), workspace);
  const configuredJournal = resolveConfiguredPath(getPathConfig(config, 'journal'), workspace);
  const configuredNotes = resolveConfiguredPath(getPathConfig(config, 'notes'), workspace);
  const stale = [];

  if (!samePath(configuredVault, obsidianVault)) stale.push(`paths.vault points at ${configuredVault}`);
  if (!pathInside(obsidianVault, configuredJournal)) stale.push(`paths.journal points outside the active vault: ${configuredJournal}`);
  if (!pathInside(obsidianVault, configuredNotes)) stale.push(`paths.notes points outside the active vault: ${configuredNotes}`);

  if (stale.length) {
    return createStatusCheck(
      'obsidian.paths',
      'warn',
      `jarvos.config.json paths are stale for active Obsidian vault ${obsidianVault}: ${stale.join('; ')}`,
      {
        path: obsidianVault,
        stale,
      },
    );
  }

  return createStatusCheck('obsidian.paths', 'ok', `jarvos.config.json paths align with active Obsidian vault: ${obsidianVault}`, {
    path: obsidianVault,
  });
}

function runMinimalDoctor(options = {}) {
  const workspace = path.resolve(options.workspace || process.cwd());
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
  checks.push(validateWorkspaceFiles(workspace));

  const configSchemaCheck = validateConfigSchema(workspace);
  checks.push(configSchemaCheck);
  for (const key of REQUIRED_PATH_KEYS) {
    checks.push(validateConfiguredDirectory(workspace, configSchemaCheck.config, key));
  }
  checks.push(validateAgentContext(workspace));
  checks.push(validateAgentContextHydration(workspace));
  checks.push(validateMemoryWikiSurface(workspace, configSchemaCheck.config));
  checks.push(validateKnowledgeOutputs(workspace, configSchemaCheck.config));
  checks.push(validateObsidianSingleWriter(workspace, configSchemaCheck.config, options));
  checks.push(validateObsidianPaths(workspace, configSchemaCheck.config, options));

  const ok = checks.every((check) => check.ok);
  return {
    profile: 'minimal',
    workspace,
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

function validateJarvosProfile(options = {}) {
  const workspace = path.resolve(options.workspace || process.cwd());
  const profile = normalizeProfile(options.profile || 'minimal');
  const packName = options.packName || (profile === 'local-openclaw' ? 'local-openclaw' : 'v0-5-0');
  const checks = runMinimalDoctor({ workspace }).checks;
  const config = readWorkspaceConfig(workspace);
  const pack = loadPack(packName);
  const plan = buildInstallPlan({
    pack,
    homeDir: options.homeDir,
    workspaceRoot: workspace,
    openclawStateDir: options.openclawStateDir,
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
      : createStatusCheck('openclaw.stateDir', 'skipped', `OpenClaw state directory is not present yet: ${options.openclawStateDir || path.join(os.homedir(), '.openclaw')}`, {
        path: stateDir?.resolvedPath || path.join(os.homedir(), '.openclaw'),
      }));

    const runtimeConfig = fileStatus(plan, 'openclaw-runtime-config');
    checks.push(runtimeConfig?.present
      ? createStatusCheck('openclaw.runtimeConfig', 'ok', `Found existing OpenClaw runtime config: ${runtimeConfig.resolvedPath}`, {
        path: runtimeConfig.resolvedPath,
      })
      : createStatusCheck('openclaw.runtimeConfig', 'skipped', 'OpenClaw runtime config is absent; jarvOS init will not create or overwrite it', {
        path: runtimeConfig?.resolvedPath || path.join(options.openclawStateDir || path.join(os.homedir(), '.openclaw'), 'openclaw.json'),
      }));
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
    ? resolveConfiguredPath(configuredManifest, workspace)
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
  const configured = config?.runtimeAdapters?.openclaw?.stateDir;
  return path.resolve(expandHome(options.openclawStateDir || configured || path.join(os.homedir(), '.openclaw')));
}

function readWorkspaceConfig(workspace) {
  const configPath = path.join(workspace, 'jarvos.config.json');
  const result = readJson(configPath);
  return result.ok ? result.value : null;
}

function validateOpenClawProfile(options = {}) {
  const workspace = path.resolve(options.workspace || process.cwd());
  const profile = normalizeProfile(options.profile || 'local-openclaw');
  const checks = runMinimalDoctor({ workspace }).checks;
  const config = readWorkspaceConfig(workspace);
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
    ? resolveConfiguredPath(configuredManifest, workspace)
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

function runProfileDoctor(options = {}) {
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

function initProfile(options = {}) {
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
  const doctor = runProfileDoctor({
    profile,
    workspace: result.workspaceRoot,
    openclawStateDir: result.openclawStateDir,
    commandsPresent: options.commandsPresent,
    filesPresent: options.filesPresent,
    homeDir: options.homeDir,
    providerVersions: options.providerVersions,
    providerStatuses: options.providerStatuses,
    gbrainCommandResults: options.gbrainCommandResults,
    gbrainRuntimeConnections: options.gbrainRuntimeConnections,
    gbrainCommandTimeoutMs: options.gbrainCommandTimeoutMs,
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
  runProfileDoctor,
  runMinimalDoctor,
  validateObsidianPaths,
  validateObsidianSingleWriter,
};
