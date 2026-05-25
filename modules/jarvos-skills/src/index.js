'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const MODULE_ROOT = path.resolve(__dirname, '..');
const MANIFEST_PATH = path.join(MODULE_ROOT, 'manifest.json');
const PACKS_DIR = path.join(MODULE_ROOT, 'packs');
const DEFAULT_PACK_NAME = 'obsidian-default';

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

  return {
    pack: pack.name,
    commands: commandDetections,
  };
}

function buildInstallPlan(options = {}) {
  const pack = options.pack || loadPack(options.packName || DEFAULT_PACK_NAME);
  const environment = options.environment || detectPackEnvironment(pack, options);
  const commandMap = new Map(environment.commands.map((command) => [command.name, command]));

  const skills = pack.skills.map((skill) => {
    const missingCommands = skill.requires.filter((commandName) => {
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
      guardrails: skill.guardrails,
    };
  });

  const missingCommands = Array.from(
    new Set(skills.flatMap((skill) => skill.missingCommands)),
  ).sort();

  return {
    pack: {
      name: pack.name,
      version: pack.version,
      title: pack.title,
      source: pack.source,
      boundary: pack.boundary,
    },
    status: missingCommands.length === 0 ? 'ready' : 'needs-optional-tools',
    skills,
    missingCommands,
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
  getManifest,
  loadPack,
  listPacks,
  listSkills,
  getSkill,
  validateBundle,
  installSkills,
};
