'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const MODULE_ROOT = path.resolve(__dirname, '..');
const MANIFEST_PATH = path.join(MODULE_ROOT, 'manifest.json');
const PACKS_DIR = path.join(MODULE_ROOT, 'packs');
const DEFAULT_PACK_NAME = 'obsidian-default';
const LOSSLESS_CLAW_PLUGIN_ID = 'lossless-claw';
const UNSAFE_LOSSLESS_SUMMARY_MODELS = new Set(['flash']);

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function getManifest() {
  return readJson(MANIFEST_PATH);
}

function loadPack(name = DEFAULT_PACK_NAME) {
  const normalized = String(name || '').trim();
  if (!/^[a-z][a-z0-9-]*$/.test(normalized)) {
    throw new Error(`Invalid jarvOS skill pack name: ${name}`);
  }

  const packPath = path.join(PACKS_DIR, `${normalized}.json`);
  const pack = readJson(packPath);
  assertPackManifest(pack);
  return pack;
}

function listPacks() {
  if (!fs.existsSync(PACKS_DIR)) return [];
  return fs
    .readdirSync(PACKS_DIR)
    .filter((file) => file.endsWith('.json'))
    .map((file) => path.basename(file, '.json'))
    .sort();
}

function listSkills() {
  return getManifest().skills.map((skill) => ({ ...skill }));
}

function getSkill(name) {
  const skill = listSkills().find((item) => item.name === name);
  if (!skill) return null;
  return {
    ...skill,
    absolutePath: path.join(MODULE_ROOT, skill.path),
    content: fs.readFileSync(path.join(MODULE_ROOT, skill.path), 'utf8'),
  };
}

function validateBundle() {
  const manifest = getManifest();
  const errors = [];
  const defaultSet = new Set(manifest.defaultSkills || []);
  const declaredSkillNames = new Set((manifest.skills || []).map((skill) => skill.name));

  for (const expected of ['workflow-execution', 'rule-creation', 'context-management', 'cron-hygiene']) {
    if (!defaultSet.has(expected)) errors.push(`Missing default skill: ${expected}`);
  }

  if (defaultSet.has('qmd')) {
    errors.push('QMD must not be bundled as a default skill.');
  }

  for (const name of defaultSet) {
    if (!declaredSkillNames.has(name)) {
      errors.push(`Default skill not declared: ${name}`);
    }
  }

  for (const skill of manifest.skills || []) {
    const skillPath = path.join(MODULE_ROOT, skill.path || '');
    if (!fs.existsSync(skillPath)) {
      errors.push(`Missing skill file: ${skill.path}`);
      continue;
    }

    const content = fs.readFileSync(skillPath, 'utf8');
    if (!content.includes(`name: ${skill.name}`)) {
      errors.push(`Skill ${skill.name} frontmatter does not declare its manifest name.`);
    }
  }

  const qmdAdapter = (manifest.optionalAdapters || []).find((adapter) => adapter.name === 'qmd');
  if (!qmdAdapter || qmdAdapter.default !== false) {
    errors.push('QMD must be documented as an optional adapter with default=false.');
  }

  return {
    ok: errors.length === 0,
    errors,
    skillCount: (manifest.skills || []).length,
    defaultSkills: [...defaultSet],
  };
}

function assertPackManifest(pack) {
  const required = ['name', 'version', 'source', 'boundary', 'skills', 'detection'];
  for (const key of required) {
    if (!pack || !Object.prototype.hasOwnProperty.call(pack, key)) {
      throw new Error(`jarvOS skill pack missing required field: ${key}`);
    }
  }

  if (!pack.source || typeof pack.source !== 'object' || Array.isArray(pack.source)) {
    throw new Error(`jarvOS skill pack ${pack.name} must declare a source object`);
  }
  for (const key of ['repo', 'commit']) {
    if (typeof pack.source[key] !== 'string' || pack.source[key].trim() === '') {
      throw new Error(`jarvOS skill pack ${pack.name} source missing ${key}`);
    }
  }

  if (!pack.detection || typeof pack.detection !== 'object' || Array.isArray(pack.detection)) {
    throw new Error(`jarvOS skill pack ${pack.name} must declare a detection object`);
  }
  if (!Array.isArray(pack.detection.commands)) {
    throw new Error(`jarvOS skill pack ${pack.name} must declare detection.commands`);
  }

  if (!Array.isArray(pack.skills) || pack.skills.length === 0) {
    throw new Error(`jarvOS skill pack ${pack.name} must declare at least one skill`);
  }

  const seen = new Set();
  const requiredCommands = new Set();
  for (const skill of pack.skills) {
    for (const key of ['name', 'sourcePath', 'role']) {
      if (typeof skill[key] !== 'string' || skill[key].trim() === '') {
        throw new Error(`${pack.name} skill missing ${key}`);
      }
    }
    if (!skill.install || typeof skill.install !== 'object' || Array.isArray(skill.install)) {
      throw new Error(`${pack.name}/${skill.name} must declare install metadata`);
    }
    if (typeof skill.install.kind !== 'string' || skill.install.kind.trim() === '') {
      throw new Error(`${pack.name}/${skill.name} install missing kind`);
    }
    if (seen.has(skill.name)) throw new Error(`${pack.name} duplicates skill ${skill.name}`);
    seen.add(skill.name);
    if (!Array.isArray(skill.guardrails)) {
      throw new Error(`${pack.name}/${skill.name} must declare guardrails`);
    }
    if (!Array.isArray(skill.requires)) {
      throw new Error(`${pack.name}/${skill.name} must declare requires`);
    }
    if (skill.optionalRequires !== undefined && !Array.isArray(skill.optionalRequires)) {
      throw new Error(`${pack.name}/${skill.name} optionalRequires must be an array`);
    }
    for (const commandName of skill.requires) {
      if (typeof commandName !== 'string' || commandName.trim() === '') {
        throw new Error(`${pack.name}/${skill.name} requires contains an invalid command`);
      }
      requiredCommands.add(commandName);
    }
  }

  const detectionNames = new Set();
  for (const command of pack.detection.commands) {
    for (const key of ['name', 'purpose', 'installHint']) {
      if (typeof command[key] !== 'string' || command[key].trim() === '') {
        throw new Error(`${pack.name} detection command missing ${key}`);
      }
    }
    if (detectionNames.has(command.name)) {
      throw new Error(`${pack.name} duplicates detection command ${command.name}`);
    }
    if (!Array.isArray(command.requiredFor)) {
      throw new Error(`${pack.name}/${command.name} must declare requiredFor`);
    }
    detectionNames.add(command.name);
  }
  for (const commandName of requiredCommands) {
    if (!detectionNames.has(commandName)) {
      throw new Error(`${pack.name} missing detection metadata for required command: ${commandName}`);
    }
  }

  if (pack.boundary.contentContractOwner !== '@jarvos/secondbrain') {
    throw new Error(`${pack.name} must keep @jarvos/secondbrain as content contract owner`);
  }
  if (pack.boundary.foundationRequired !== false) {
    throw new Error(`${pack.name} must keep Obsidian optional`);
  }

  return true;
}

function commandExists(command) {
  const result = process.platform === 'win32'
    ? spawnSync('where.exe', [command], { stdio: 'ignore' })
    : spawnSync('sh', ['-lc', `command -v ${shellQuote(command)} >/dev/null 2>&1`], {
      stdio: 'ignore',
    });
  return result.status === 0;
}

function expandPath(value, options = {}) {
  const homeDir = options.homeDir || os.homedir();
  const workspaceRoot = options.workspaceRoot || process.cwd();
  return String(value || '')
    .replace(/^~(?=$|\/)/, homeDir)
    .replaceAll('{workspace}', workspaceRoot);
}

function resolveDetectionFilePath(file, options = {}) {
  const openclawStateDir = options.openclawStateDir
    ? path.resolve(expandPath(options.openclawStateDir, options))
    : null;
  if (openclawStateDir && file.name === 'openclaw-state-dir') return openclawStateDir;
  if (openclawStateDir && file.name === 'openclaw-runtime-config') {
    return path.join(openclawStateDir, 'openclaw.json');
  }
  return expandPath(file.path, options);
}

function fileExists(file, options = {}) {
  return fs.existsSync(resolveDetectionFilePath(file, options));
}

function detectPackEnvironment(pack = loadPack(DEFAULT_PACK_NAME), options = {}) {
  const commandsPresent = options.commandsPresent || {};
  const commandDetections = (pack.detection.commands || []).map((command) => {
    const present =
      Object.prototype.hasOwnProperty.call(commandsPresent, command.name)
        ? Boolean(commandsPresent[command.name])
        : commandExists(command.name);
    return {
      ...command,
      present,
    };
  });
  const filesPresent = options.filesPresent || {};
  const fileDetections = (pack.detection.files || []).map((file) => {
    const present =
      Object.prototype.hasOwnProperty.call(filesPresent, file.name)
        ? Boolean(filesPresent[file.name])
        : fileExists(file, options);
    return {
      ...file,
      resolvedPath: resolveDetectionFilePath(file, options),
      present,
    };
  });

  return {
    pack: pack.name,
    commands: commandDetections,
    files: fileDetections,
  };
}

function buildInstallPlan(options = {}) {
  const pack = options.pack || loadPack(options.packName || DEFAULT_PACK_NAME);
  const environment = options.environment || detectPackEnvironment(pack, options);
  const commandMap = new Map(environment.commands.map((command) => [command.name, command]));
  const losslessClaw = pack.name === 'local-openclaw'
    ? inspectLosslessClaw({
      homeDir: options.homeDir,
      workspaceRoot: options.workspaceRoot,
      openclawStateDir: options.openclawStateDir,
      commandsPresent: options.commandsPresent,
      environment,
      now: options.now,
    })
    : null;
  const losslessDetected = Boolean(losslessClaw && losslessClaw.state !== 'missing');

  const skills = pack.skills.map((skill) => {
    const missingCommands = skill.requires.filter((commandName) => {
      if (commandName === LOSSLESS_CLAW_PLUGIN_ID && losslessDetected) return false;
      const command = commandMap.get(commandName);
      return !command || !command.present;
    });
    const missingOptionalCommands = (skill.optionalRequires || []).filter((commandName) => {
      if (commandName === LOSSLESS_CLAW_PLUGIN_ID && losslessDetected) return false;
      const command = commandMap.get(commandName);
      return !command || !command.present;
    });
    return {
      name: skill.name,
      sourcePath: skill.sourcePath,
      role: skill.role,
      install: skill.install,
      ready: missingCommands.length === 0,
      missingCommands,
      missingOptionalCommands,
      guardrails: skill.guardrails,
    };
  });

  const missingCommands = Array.from(
    new Set(skills.flatMap((skill) => skill.missingCommands)),
  ).sort();
  const missingOptionalCommands = Array.from(
    new Set(skills.flatMap((skill) => skill.missingOptionalCommands)),
  ).sort();
  const missingRequiredCommands = missingCommands.filter((commandName) => {
    const command = commandMap.get(commandName);
    return command && command.required === true;
  });
  const missingFiles = (environment.files || [])
    .filter((file) => file.required === true && !file.present)
    .map((file) => file.name)
    .sort();

  let status = 'ready';
  if (missingRequiredCommands.length > 0 || missingFiles.length > 0) {
    status = 'needs-runtime';
  } else if (missingCommands.length > 0) {
    status = 'needs-optional-tools';
  }

  return {
    pack: {
      name: pack.name,
      version: pack.version,
      title: pack.title,
      source: pack.source,
      boundary: pack.boundary,
    },
    status,
    skills,
    missingCommands,
    missingOptionalCommands,
    missingRequiredCommands,
    missingFiles,
    environment,
    ...(losslessClaw ? { losslessClaw } : {}),
    setup: buildSetupSteps(pack, missingCommands),
  };
}

function buildSetupSteps(pack, missingCommands) {
  const steps = [
    'Install the pack skills into the assistant skill directory for the runtime that will use jarvOS.',
    'Configure jarvos-secondbrain paths with JARVOS_NOTES_DIR and JARVOS_JOURNAL_DIR, or paths.notes and paths.journal in jarvos.config.json.',
    'Keep Paperclip as the live task authority; use Obsidian Bases and Canvas as reading/artifact surfaces only.',
  ];

  for (const command of pack.detection.commands || []) {
    if (missingCommands.includes(command.name)) {
      steps.push(command.installHint);
    }
  }

  return steps;
}

function readJsonIfPresent(filePath) {
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function isPlainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function mergeMissing(target, defaults) {
  const output = isPlainObject(target) ? { ...target } : {};
  for (const [key, value] of Object.entries(defaults || {})) {
    if (!Object.prototype.hasOwnProperty.call(output, key)) {
      output[key] = value;
    } else if (isPlainObject(output[key]) && isPlainObject(value)) {
      output[key] = mergeMissing(output[key], value);
    }
  }
  return output;
}

function unionArray(existing, values) {
  return Array.from(new Set([...(Array.isArray(existing) ? existing : []), ...values]));
}

function writeJsonIfChanged(filePath, data, options = {}) {
  const next = `${JSON.stringify(data, null, 2)}\n`;
  if (fs.existsSync(filePath) && fs.readFileSync(filePath, 'utf8') === next) {
    return 'unchanged';
  }
  const existed = fs.existsSync(filePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  if (existed && options.backupExisting) {
    const backupPath = `${filePath}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    fs.copyFileSync(filePath, backupPath);
    if (Array.isArray(options.backups)) {
      options.backups.push(backupPath);
    }
  }
  fs.writeFileSync(filePath, next);
  return existed ? 'written' : 'created';
}

function writeJsonIfMissing(filePath, data) {
  if (fs.existsSync(filePath)) return 'preserved';
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`);
  return 'created';
}

function copyFileBackup(filePath, now = new Date()) {
  if (!fs.existsSync(filePath)) return null;
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const backupPath = `${filePath}.jarvos-backup-${stamp}`;
  fs.copyFileSync(filePath, backupPath, fs.constants.COPYFILE_EXCL);
  return backupPath;
}

function relativeOrAbsolute(fromDir, toPath) {
  const rel = path.relative(fromDir, toPath);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : toPath;
}

function defaultOpenClawStateDir(options = {}) {
  return path.resolve(expandPath(options.openclawStateDir || path.join(options.homeDir || os.homedir(), '.openclaw'), options));
}

function defaultLosslessClawExtensionPath(openclawStateDir) {
  return path.join(openclawStateDir, 'extensions', LOSSLESS_CLAW_PLUGIN_ID);
}

function losslessClawConfigContainers(config) {
  const plugins = isPlainObject(config && config.plugins) ? config.plugins : {};
  return [
    plugins[LOSSLESS_CLAW_PLUGIN_ID],
    isPlainObject(plugins.entries) ? plugins.entries[LOSSLESS_CLAW_PLUGIN_ID] : null,
  ].filter(isPlainObject);
}

function readLosslessClawSummaryModel(config) {
  for (const container of losslessClawConfigContainers(config)) {
    if (isPlainObject(container.config) && typeof container.config.summaryModel === 'string') {
      return container.config.summaryModel;
    }
    if (typeof container.summaryModel === 'string') return container.summaryModel;
  }
  return null;
}

function clearUnsafeLosslessClawSummaryModels(config) {
  let changed = false;
  for (const container of losslessClawConfigContainers(config)) {
    if (isPlainObject(container.config) && UNSAFE_LOSSLESS_SUMMARY_MODELS.has(String(container.config.summaryModel || '').toLowerCase())) {
      delete container.config.summaryModel;
      changed = true;
    }
    if (UNSAFE_LOSSLESS_SUMMARY_MODELS.has(String(container.summaryModel || '').toLowerCase())) {
      delete container.summaryModel;
      changed = true;
    }
  }
  return changed;
}

function evaluateLosslessClawHealth(input = {}) {
  const config = isPlainObject(input.config) ? input.config : {};
  const plugins = isPlainObject(config.plugins) ? config.plugins : {};
  const installs = isPlainObject(plugins.installs) ? plugins.installs : {};
  const install = isPlainObject(installs[LOSSLESS_CLAW_PLUGIN_ID]) ? installs[LOSSLESS_CLAW_PLUGIN_ID] : null;
  const slot = isPlainObject(plugins.slots) ? plugins.slots.contextEngine || null : null;
  const summaryModel = readLosslessClawSummaryModel(config);
  const unsafeSummaryModel = typeof summaryModel === 'string'
    && UNSAFE_LOSSLESS_SUMMARY_MODELS.has(summaryModel.toLowerCase());
  const update = isPlainObject(config.update) ? config.update : {};
  const autoUpdateEnabled = update.checkOnStart === true
    || (isPlainObject(update.auto) && update.auto.enabled === true);
  const installPath = typeof input.installPath === 'string'
    ? input.installPath
    : typeof install?.installPath === 'string'
      ? install.installPath
      : null;
  const installPathExists = typeof input.installPathExists === 'boolean'
    ? input.installPathExists
    : Boolean(installPath && fs.existsSync(installPath));
  const extensionExists = Boolean(input.extensionExists);
  const commandPresent = Boolean(input.commandPresent);
  const installedOrDetected = commandPresent || extensionExists || Boolean(installPath);

  const reasons = [];
  if (!installedOrDetected) reasons.push('lossless-claw was not detected as a command, extension, or install record');
  if (installedOrDetected && slot !== LOSSLESS_CLAW_PLUGIN_ID) reasons.push('OpenClaw contextEngine slot is not lossless-claw');
  if (slot === LOSSLESS_CLAW_PLUGIN_ID && installPath && !installPathExists) reasons.push(`Configured lossless-claw installPath does not exist: ${installPath}`);
  if (slot === LOSSLESS_CLAW_PLUGIN_ID && !installPath && !extensionExists) reasons.push('lossless-claw contextEngine is enabled but no extension path was detected');
  if (unsafeSummaryModel) reasons.push(`lossless-claw summaryModel "${summaryModel}" is unsafe and should use the OpenClaw default or a real model id`);
  if (autoUpdateEnabled) reasons.push('OpenClaw background auto-update is enabled and can churn lossless-claw install metadata');

  let state = 'missing';
  if (installedOrDetected && slot !== LOSSLESS_CLAW_PLUGIN_ID) {
    state = 'disabled';
  } else if (slot === LOSSLESS_CLAW_PLUGIN_ID) {
    state = reasons.length > 0 ? 'degraded' : 'healthy';
  }

  return {
    state,
    ok: state !== 'degraded',
    pluginId: LOSSLESS_CLAW_PLUGIN_ID,
    commandPresent,
    slot,
    installPath,
    installPathExists,
    extensionExists,
    summaryModel,
    unsafeSummaryModel,
    autoUpdateEnabled,
    reasons,
  };
}

function inspectLosslessClaw(options = {}) {
  const homeDir = options.homeDir || os.homedir();
  const workspaceRoot = options.workspaceRoot || process.cwd();
  const openclawStateDir = defaultOpenClawStateDir({ ...options, homeDir, workspaceRoot });
  const runtimeConfigPath = path.join(openclawStateDir, 'openclaw.json');
  const extensionPath = defaultLosslessClawExtensionPath(openclawStateDir);
  const config = readJsonIfPresent(runtimeConfigPath) || {};
  const commandFromEnvironment = options.environment?.commands?.find((command) => command.name === LOSSLESS_CLAW_PLUGIN_ID);
  const commandPresent = options.commandsPresent && Object.prototype.hasOwnProperty.call(options.commandsPresent, LOSSLESS_CLAW_PLUGIN_ID)
    ? Boolean(options.commandsPresent[LOSSLESS_CLAW_PLUGIN_ID])
    : Boolean(commandFromEnvironment?.present);

  return {
    ...evaluateLosslessClawHealth({
      config,
      commandPresent,
      extensionExists: fs.existsSync(extensionPath),
    }),
    openclawStateDir,
    runtimeConfigPath,
    configPresent: fs.existsSync(runtimeConfigPath),
    extensionPath,
  };
}

function enableLosslessClawInOpenClawConfig(options = {}) {
  const homeDir = options.homeDir || os.homedir();
  const workspaceRoot = options.workspaceRoot || process.cwd();
  const openclawStateDir = defaultOpenClawStateDir({ ...options, homeDir, workspaceRoot });
  const runtimeConfigPath = path.resolve(expandPath(
    options.runtimeConfigPath || path.join(openclawStateDir, 'openclaw.json'),
    { homeDir, workspaceRoot },
  ));
  const extensionPath = path.resolve(expandPath(
    options.losslessClawPath || defaultLosslessClawExtensionPath(openclawStateDir),
    { homeDir, workspaceRoot },
  ));
  const existingConfig = readJsonIfPresent(runtimeConfigPath) || {};
  const nextConfig = mergeMissing(existingConfig, {
    plugins: {
      slots: {
        contextEngine: LOSSLESS_CLAW_PLUGIN_ID,
      },
      installs: {},
    },
    update: {
      checkOnStart: false,
      auto: {
        enabled: false,
      },
    },
  });

  nextConfig.plugins = isPlainObject(nextConfig.plugins) ? nextConfig.plugins : {};
  nextConfig.plugins.slots = {
    ...(isPlainObject(nextConfig.plugins.slots) ? nextConfig.plugins.slots : {}),
    contextEngine: LOSSLESS_CLAW_PLUGIN_ID,
  };
  nextConfig.plugins.allow = unionArray(nextConfig.plugins.allow, [LOSSLESS_CLAW_PLUGIN_ID]);
  nextConfig.plugins.installs = isPlainObject(nextConfig.plugins.installs) ? nextConfig.plugins.installs : {};
  if (fs.existsSync(extensionPath)) {
    nextConfig.plugins.installs[LOSSLESS_CLAW_PLUGIN_ID] = {
      ...(isPlainObject(nextConfig.plugins.installs[LOSSLESS_CLAW_PLUGIN_ID]) ? nextConfig.plugins.installs[LOSSLESS_CLAW_PLUGIN_ID] : {}),
      installPath: extensionPath,
    };
  }
  nextConfig.update = isPlainObject(nextConfig.update) ? nextConfig.update : {};
  nextConfig.update.checkOnStart = false;
  nextConfig.update.auto = {
    ...(isPlainObject(nextConfig.update.auto) ? nextConfig.update.auto : {}),
    enabled: false,
  };

  const clearedUnsafeSummaryModel = clearUnsafeLosslessClawSummaryModels(nextConfig);
  fs.mkdirSync(path.dirname(runtimeConfigPath), { recursive: true });
  const backupPath = copyFileBackup(runtimeConfigPath, options.now || new Date());
  const writeStatus = writeJsonIfChanged(runtimeConfigPath, nextConfig);
  const health = evaluateLosslessClawHealth({
    config: nextConfig,
    extensionExists: fs.existsSync(extensionPath),
  });

  return {
    runtimeConfigPath,
    openclawStateDir,
    extensionPath,
    backupPath,
    writeStatus,
    guards: {
      autoUpdateDisabled: true,
      clearedUnsafeSummaryModel,
    },
    health,
  };
}

function buildLocalOpenClawConfig({ pack, workspaceRoot, openclawStateDir, installedSkillsManifestPath }) {
  return {
    $schema: './jarvos.config.schema.json',
    paths: {
      workspace: workspaceRoot,
      vault: path.join(workspaceRoot, 'Vault'),
      notes: path.join(workspaceRoot, 'Vault', 'Notes'),
      journal: path.join(workspaceRoot, 'Vault', 'Journal'),
      memory: path.join(workspaceRoot, 'memory'),
      scripts: path.join(workspaceRoot, 'scripts'),
      workflows: path.join(workspaceRoot, 'workflows'),
      customers: path.join(workspaceRoot, 'customers'),
    },
    runtimeAdapters: {
      openclaw: {
        kind: 'openclaw',
        stateDir: openclawStateDir,
        configPath: path.join(openclawStateDir, 'openclaw.json'),
        skillPack: pack.name,
        installedSkillsManifest: installedSkillsManifestPath,
      },
    },
    skillPacks: {
      installed: [pack.name],
    },
  };
}

function buildPortableProfileConfig({ pack, workspaceRoot }) {
  return {
    $schema: './jarvos.config.schema.json',
    paths: {
      workspace: workspaceRoot,
      vault: path.join(workspaceRoot, 'Vault'),
      notes: path.join(workspaceRoot, 'Vault', 'Notes'),
      journal: path.join(workspaceRoot, 'Vault', 'Journal'),
      memory: path.join(workspaceRoot, 'memory'),
      scripts: path.join(workspaceRoot, 'scripts'),
      workflows: path.join(workspaceRoot, 'workflows'),
      customers: path.join(workspaceRoot, 'customers'),
    },
    skillPacks: {
      installed: [pack.name],
    },
  };
}

function buildInstalledSkillsManifest(pack, workspaceRoot) {
  return {
    name: pack.name,
    version: pack.version,
    installedAt: null,
    source: pack.source,
    skills: pack.skills.map((skill) => ({
      name: skill.name,
      sourcePath: skill.sourcePath,
      install: skill.install,
      target: skill.install.target,
      guardrails: skill.guardrails,
    })),
    notes: [
      'This manifest records the reusable profile intent. Runtime-specific installers may copy or link skills from these source paths.',
      'Paperclip remains the live tracker; runtime adapters are optional per selected profile.',
    ],
    workspaceRoot,
  };
}

function initJarvosWorkspace(options = {}) {
  const pack = options.pack || loadPack(options.packName || 'local-openclaw');
  const isLocalOpenClawPack = pack.name === 'local-openclaw';

  const homeDir = options.homeDir || os.homedir();
  const workspaceRoot = path.resolve(expandPath(options.workspaceRoot || process.cwd(), { homeDir }));
  const openclawStateDir = isLocalOpenClawPack
    ? path.resolve(expandPath(
      options.openclawStateDir || path.join(homeDir, '.openclaw'),
      { homeDir, workspaceRoot },
    ))
    : null;
  const configPath = path.resolve(expandPath(
    options.configPath || path.join(workspaceRoot, 'jarvos.config.json'),
    { homeDir, workspaceRoot },
  ));
  const installedSkillsManifestPath = path.join(
    workspaceRoot,
    '.jarvos',
    'installed-skills',
    `${pack.name}.json`,
  );
  const workspaceStatePath = isLocalOpenClawPack
    ? path.join(openclawStateDir, 'workspace-state.json')
    : path.join(workspaceRoot, '.jarvos', 'workspace-state.json');
  const runtimeConfigPath = isLocalOpenClawPack ? path.join(openclawStateDir, 'openclaw.json') : null;
  const backups = [];
  const losslessEnableResult = (options.enableLosslessClaw && isLocalOpenClawPack)
    ? enableLosslessClawInOpenClawConfig({
      homeDir,
      workspaceRoot,
      openclawStateDir,
      runtimeConfigPath,
      losslessClawPath: options.losslessClawPath,
      now: options.now,
    })
    : null;

  const configInstallPath = relativeOrAbsolute(path.dirname(configPath), installedSkillsManifestPath);
  const defaults = isLocalOpenClawPack
    ? buildLocalOpenClawConfig({
      pack,
      workspaceRoot,
      openclawStateDir,
      installedSkillsManifestPath: configInstallPath,
    })
    : buildPortableProfileConfig({
      pack,
      workspaceRoot,
    });
  const existingConfig = readJsonIfPresent(configPath) || {};
  const mergedConfig = mergeMissing(existingConfig, defaults);
  mergedConfig.skillPacks = {
    ...(isPlainObject(mergedConfig.skillPacks) ? mergedConfig.skillPacks : {}),
    installed: unionArray(mergedConfig.skillPacks && mergedConfig.skillPacks.installed, [pack.name]),
  };

  const existingWorkspaceState = readJsonIfPresent(workspaceStatePath) || {};
  const mergedWorkspaceState = mergeMissing(existingWorkspaceState, {
    version: 1,
    jarvos: {
      profiles: {
        [pack.name]: {
          version: pack.version,
          workspaceRoot,
          configPath,
          installedSkillsManifestPath,
        },
      },
    },
  });

  fs.mkdirSync(workspaceRoot, { recursive: true });
  ensureWorkspaceDirectories(workspaceRoot, mergedConfig);
  const writes = {
    config: writeJsonIfChanged(configPath, mergedConfig, {
      backupExisting: true,
      backups,
    }),
    workspaceState: writeJsonIfChanged(workspaceStatePath, mergedWorkspaceState, {
      backupExisting: true,
      backups,
    }),
    installedSkillsManifest: writeJsonIfMissing(
      installedSkillsManifestPath,
      buildInstalledSkillsManifest(pack, workspaceRoot),
    ),
    runtimeConfig: isLocalOpenClawPack
      ? (losslessEnableResult
        ? losslessEnableResult.writeStatus
        : fs.existsSync(runtimeConfigPath) ? 'preserved' : 'absent-not-created')
      : 'not-applicable',
  };

  const plan = buildInstallPlan({
    pack,
    homeDir,
    workspaceRoot,
    openclawStateDir,
    commandsPresent: options.commandsPresent,
    filesPresent: options.filesPresent,
  });

  return {
    ok: true,
    pack: pack.name,
    workspaceRoot,
    configPath,
    openclawStateDir,
    workspaceStatePath,
    runtimeConfigPath,
    installedSkillsManifestPath,
    writes,
    backups,
    ...(losslessEnableResult ? { losslessClaw: losslessEnableResult } : {}),
    plan,
  };
}

function ensureWorkspaceDirectories(workspaceRoot, config) {
  const paths = config && config.paths && isPlainObject(config.paths) ? config.paths : {};
  for (const key of ['vault', 'notes', 'journal', 'memory', 'scripts', 'workflows', 'customers']) {
    if (typeof paths[key] !== 'string') continue;
    const resolved = path.resolve(expandPath(paths[key], { workspaceRoot }));
    if (resolved === workspaceRoot || resolved.startsWith(`${workspaceRoot}${path.sep}`)) {
      fs.mkdirSync(resolved, { recursive: true });
    }
  }
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function copyFileSync(source, destination) {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination);
}

function installSkills(destinationDir, options = {}) {
  if (!destinationDir) {
    throw new Error('destinationDir is required');
  }

  const manifest = getManifest();
  const names = options.skills === undefined
    ? manifest.defaultSkills
    : Array.isArray(options.skills)
      ? options.skills
      : [options.skills];

  const plan = names.map((name) => {
    const skill = getSkill(name);
    if (!skill) throw new Error(`Unknown skill: ${name}`);
    return { name, source: skill.absolutePath, target: path.join(destinationDir, name, 'SKILL.md') };
  });

  if (!options.force) {
    const existing = plan.filter((entry) => fs.existsSync(entry.target)).map((entry) => entry.target);
    if (existing.length > 0) {
      throw new Error(`Refusing to overwrite existing skill without force: ${existing.join(', ')}`);
    }
  }

  const installed = [];
  for (const entry of plan) {
    copyFileSync(entry.source, entry.target);
    installed.push({ name: entry.name, path: entry.target });
  }

  return installed;
}

module.exports = {
  DEFAULT_PACK_NAME,
  MODULE_ROOT,
  MANIFEST_PATH,
  PACKS_DIR,
  assertPackManifest,
  buildInstallPlan,
  detectPackEnvironment,
  enableLosslessClawInOpenClawConfig,
  evaluateLosslessClawHealth,
  getManifest,
  initJarvosWorkspace,
  inspectLosslessClaw,
  loadPack,
  listPacks,
  listSkills,
  getSkill,
  validateBundle,
  installSkills,
};
