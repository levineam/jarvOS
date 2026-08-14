'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const crypto = require('crypto');

const MODULE_ROOT = path.resolve(__dirname, '..');
const MANIFEST_PATH = path.join(MODULE_ROOT, 'manifest.json');
const PACKS_DIR = path.join(MODULE_ROOT, 'packs');
const PACKAGE_JSON_PATH = path.join(MODULE_ROOT, 'package.json');
const DEFAULT_PACK_NAME = 'obsidian-default';
const LOSSLESS_CLAW_PLUGIN_ID = 'lossless-claw';
const UNSAFE_LOSSLESS_SUMMARY_MODELS = new Set(['flash']);
const CANONICAL_REPOSITORY = 'https://github.com/levineam/jarvOS.git';
const SKILL_INSTALL_EVENT_VERSION = 'jarvos.skill-install.v1';
const SKILL_INSTALL_EVENT_ROOT_ENV = 'JARVOS_SKILL_PROJECTION_EVENT_ROOT';
const SKILL_PROJECTION_TRIGGER_ENV = 'JARVOS_SKILL_PROJECTION_TRIGGER';
const SKILL_PROJECTION_TRIGGER_TIMEOUT_MS = 10000;

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function getManifest() {
  return readJson(MANIFEST_PATH);
}

function loadPack(name = DEFAULT_PACK_NAME) {
  const normalized = String(name || '').trim();
  if (!isSafeSkillName(normalized)) {
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

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function readInstallerVersion() {
  try {
    const packageJson = readJson(PACKAGE_JSON_PATH);
    return typeof packageJson.version === 'string' && packageJson.version.trim()
      ? packageJson.version.trim()
      : 'unknown';
  } catch (_) {
    return 'unknown';
  }
}

function sourceCodeDigest(root = MODULE_ROOT) {
  const sourceRoot = path.join(root, 'src');
  const files = [];
  function walk(directory, relative) {
    for (const name of fs.readdirSync(directory).sort()) {
      const absolute = path.join(directory, name);
      const childRelative = path.posix.join(relative, name);
      const stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink()) throw new Error(`source code path is a symbolic link: ${childRelative}`);
      if (stat.isDirectory()) walk(absolute, childRelative);
      else if (stat.isFile()) files.push(`${childRelative}\0${sha256(fs.readFileSync(absolute))}`);
      else throw new Error(`source code path is not a regular file: ${childRelative}`);
    }
  }
  walk(sourceRoot, 'src');
  return sha256(files.join('\n'));
}

function manifestDigest() {
  return sha256(fs.readFileSync(MANIFEST_PATH));
}

function currentGitCommit(root = MODULE_ROOT) {
  const result = spawnSync('git', ['-C', root, 'rev-parse', 'HEAD'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    env: { PATH: process.env.PATH || '/usr/bin:/bin', HOME: process.env.HOME || os.homedir(), LANG: 'C', LC_ALL: 'C' },
  });
  const commit = result.status === 0 ? String(result.stdout || '').trim() : '';
  return /^[a-f0-9]{40}$/i.test(commit) ? commit.toLowerCase() : null;
}

function expandInstallEventRoot(value) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('skill install event root must be configured');
  const expanded = value === '~'
    ? os.homedir()
    : value.startsWith('~/') ? path.join(os.homedir(), value.slice(2)) : value;
  if (!path.isAbsolute(expanded)) throw new Error('skill install event root must be absolute');
  return path.resolve(expanded);
}

function ensureOwnerOnlyEventRoot(root) {
  const absolute = expandInstallEventRoot(root);
  fs.mkdirSync(absolute, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(absolute);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('skill install event root must be a real directory');
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) throw new Error('skill install event root must be owned by the current user');
  if ((stat.mode & 0o077) !== 0) throw new Error('skill install event root must be owner-only');
  const pending = path.join(absolute, 'pending');
  fs.mkdirSync(pending, { recursive: true, mode: 0o700 });
  const pendingStat = fs.lstatSync(pending);
  if (pendingStat.isSymbolicLink() || !pendingStat.isDirectory() || (typeof process.getuid === 'function' && pendingStat.uid !== process.getuid()) || (pendingStat.mode & 0o077) !== 0) throw new Error('skill install event inbox must be owner-only');
  return { root: fs.realpathSync(absolute), pending: fs.realpathSync(pending) };
}

function releaseTupleForInstall(manifest, names, options = {}) {
  const supplied = options.release && typeof options.release === 'object' ? options.release : {};
  const repository = supplied.repository || manifest.release?.repository || process.env.JARVOS_SKILLS_REPOSITORY || CANONICAL_REPOSITORY;
  const commit = supplied.commit || manifest.release?.commit || process.env.JARVOS_SKILLS_COMMIT || currentGitCommit();
  const actualManifestDigest = manifestDigest();
  const actualCodeDigest = sourceCodeDigest();
  const manifestDigestValue = supplied.manifestDigest || manifest.release?.manifestDigest || process.env.JARVOS_SKILLS_MANIFEST_DIGEST || actualManifestDigest;
  const codeDigest = supplied.sourceCodeDigest || manifest.release?.sourceCodeDigest || process.env.JARVOS_SKILLS_SOURCE_CODE_DIGEST || actualCodeDigest;
  const skills = (manifest.skills || []).map((skill) => ({ name: skill.name, digest: String(skill.source?.digest || '').toLowerCase() }));
  if (Array.isArray(supplied.skills) && supplied.skills.length > 0) {
    const suppliedByName = new Map(supplied.skills.map((skill) => [skill?.name, String(skill?.digest || '').toLowerCase()]));
    for (const skill of skills) {
      if (suppliedByName.get(skill.name) !== skill.digest) throw new Error(`release skill digest does not match manifest: ${skill.name}`);
    }
  }
  if (!/^https:\/\/github\.com\/[^/]+\/[^/]+\.git$/.test(repository)) throw new Error('release repository is invalid');
  if (!/^[a-f0-9]{40}$/i.test(commit || '')) throw new Error('release commit is required for install event');
  if (!/^[a-f0-9]{64}$/i.test(manifestDigestValue || '') || !/^[a-f0-9]{64}$/i.test(codeDigest || '')) throw new Error('release digests are required for install event');
  if (manifestDigestValue.toLowerCase() !== actualManifestDigest || codeDigest.toLowerCase() !== actualCodeDigest) throw new Error('release digests do not match installed jarvOS bytes');
  if (skills.length === 0 || skills.some((skill) => !/^[a-z][a-z0-9-]*$/.test(skill.name) || !/^[a-f0-9]{64}$/.test(skill.digest))) throw new Error('release skills are invalid');
  return {
    repository,
    commit: commit.toLowerCase(),
    manifestDigest: manifestDigestValue.toLowerCase(),
    sourceCodeDigest: codeDigest.toLowerCase(),
    skills,
  };
}

function installEventPayload({ manifest, names, destinationDir, installed, options = {} }) {
  const release = releaseTupleForInstall(manifest, names, options);
  const targetRoot = fs.realpathSync(path.resolve(destinationDir));
  const occurredAt = options.occurredAt || new Date().toISOString();
  if (Number.isNaN(Date.parse(occurredAt))) throw new Error('install event timestamp is invalid');
  const nonce = options.nonce || crypto.randomBytes(24).toString('hex');
  if (!/^[a-f0-9]{32,128}$/i.test(nonce)) throw new Error('install event nonce is invalid');
  const installerVersion = options.installerVersion || readInstallerVersion();
  const installedSkills = installed.map((item) => ({
    name: item.name,
    target: path.posix.join(item.name, 'SKILL.md'),
    sourceDigest: sha256(fs.readFileSync(path.join(MODULE_ROOT, manifest.skills.find((skill) => skill.name === item.name).path))),
    outputDigest: sha256(fs.readFileSync(item.path)),
  }));
  const base = {
    version: SKILL_INSTALL_EVENT_VERSION,
    installerVersion: String(installerVersion),
    release,
    targetRoot,
    installed: installedSkills,
    occurredAt,
    nonce,
  };
  const eventId = `skill-install-${sha256(JSON.stringify(base)).slice(0, 48)}`;
  const eventDigest = sha256(JSON.stringify({ ...base, eventId }));
  return { ...base, eventId, eventDigest };
}

function writeInstallEvent(event, eventRoot, options = {}) {
  const roots = ensureOwnerOnlyEventRoot(eventRoot);
  const filePath = path.join(roots.pending, `${event.eventId}.json`);
  const temporary = path.join(roots.pending, `.${event.eventId}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`);
  const bytes = Buffer.from(`${JSON.stringify(event, null, 2)}\n`, 'utf8');
  let fd;
  try {
    fd = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(fd, bytes);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.chmodSync(temporary, 0o600);
    fs.renameSync(temporary, filePath);
    return { ...event, path: filePath };
  } catch (error) {
    if (fd !== undefined) fs.closeSync(fd);
    try { fs.unlinkSync(temporary); } catch (_) { /* best effort cleanup of our temp file */ }
    throw error;
  }
}

function resolveProjectionTrigger(value) {
  if (typeof value !== 'string' || !value.trim() || !path.isAbsolute(value)) {
    throw new Error('skill projection trigger must be an absolute path');
  }
  const absolute = path.resolve(value);
  const stat = fs.lstatSync(absolute);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('skill projection trigger must be a regular file');
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) throw new Error('skill projection trigger must be owned by the current user');
  if ((stat.mode & 0o022) !== 0) throw new Error('skill projection trigger must not be group- or world-writable');
  const real = fs.realpathSync(absolute);
  const realStat = fs.statSync(real);
  if (!realStat.isFile() || (typeof process.getuid === 'function' && realStat.uid !== process.getuid()) || (realStat.mode & 0o022) !== 0) {
    throw new Error('skill projection trigger changed during validation');
  }
  return real;
}

function triggerSkillProjection(eventRoot, options = {}) {
  const configured = options.projectionTrigger || process.env[SKILL_PROJECTION_TRIGGER_ENV];
  if (!configured) return null;
  let trigger;
  let root;
  try {
    trigger = resolveProjectionTrigger(configured);
    root = fs.realpathSync(expandInstallEventRoot(eventRoot));
  } catch (_) {
    return { status: 'failed', reason: 'projection_trigger_invalid' };
  }
  const run = options.spawn || spawnSync;
  let result;
  try {
    result = run(process.execPath, [trigger, '--event', '--apply', '--event-root', root], {
      cwd: MODULE_ROOT,
      env: {
        ...process.env,
        [SKILL_INSTALL_EVENT_ROOT_ENV]: root,
      },
      stdio: 'ignore',
      timeout: SKILL_PROJECTION_TRIGGER_TIMEOUT_MS,
      maxBuffer: 4096,
    });
  } catch (_) {
    return { status: 'failed', reason: 'projection_trigger_failed' };
  }
  if (result?.error || result?.status !== 0) return { status: 'failed', reason: 'projection_trigger_failed' };
  return { status: 'triggered' };
}

function emitInstallEvent({ manifest = getManifest(), names, destinationDir, installed, options = {} } = {}) {
  const eventRoot = options.eventRoot || process.env[SKILL_INSTALL_EVENT_ROOT_ENV];
  if (!eventRoot) return null;
  const event = installEventPayload({ manifest, names, destinationDir, installed, options });
  return writeInstallEvent(event, eventRoot, options);
}

function isSafeSkillName(name) {
  return typeof name === 'string' && /^[a-z][a-z0-9-]*$/.test(name);
}

function manifestSkillPath(skill) {
  if (!skill || typeof skill.path !== 'string' || skill.path.startsWith('/') || skill.path.split('/').includes('..')) {
    throw new Error(`Skill ${skill?.name || 'unknown'} has an unsafe source path`);
  }
  return path.join(MODULE_ROOT, skill.path);
}

function projectionMetadata(skill, harness) {
  const target = skill?.projection?.targets?.[harness];
  if (!target) return null;
  return target;
}

function assertProjectionManifest(manifest, options = {}) {
  if (!manifest || !Array.isArray(manifest.skills)) throw new Error('jarvOS skill manifest must declare skills');
  const captureSourceNames = options.captureSourceNames instanceof Set
    ? options.captureSourceNames
    : new Set(Array.isArray(options.captureSourceNames) ? options.captureSourceNames : []);
  const capturedSources = new Map();
  for (const skill of manifest.skills) {
    if (!isSafeSkillName(skill.name)) throw new Error(`Invalid skill name: ${skill.name}`);
    const sourcePath = manifestSkillPath(skill);
    if (!skill.source || typeof skill.source !== 'object') throw new Error(`Skill ${skill.name} missing source metadata`);
    for (const key of ['revision', 'digest', 'license', 'provenance']) {
      if (typeof skill.source[key] !== 'string' || skill.source[key].trim() === '') {
        throw new Error(`Skill ${skill.name} source missing ${key}`);
      }
    }
    if (!/^[a-f0-9]{64}$/i.test(skill.source.digest)) throw new Error(`Skill ${skill.name} source digest must be SHA-256`);
    const sourceContent = fs.readFileSync(sourcePath);
    if (sha256(sourceContent) !== skill.source.digest) throw new Error(`Skill ${skill.name} source digest does not match ${skill.path}`);
    if (captureSourceNames.has(skill.name)) capturedSources.set(skill.name, sourceContent);
    if (!Array.isArray(skill.supportedHarnesses) || skill.supportedHarnesses.length === 0) {
      throw new Error(`Skill ${skill.name} missing supportedHarnesses`);
    }
    if (!skill.projection || typeof skill.projection !== 'object' || typeof skill.projection.mode !== 'string' || !skill.projection.targets || typeof skill.projection.targets !== 'object') {
      throw new Error(`Skill ${skill.name} missing projection metadata`);
    }
    for (const harness of skill.supportedHarnesses) {
      const target = projectionMetadata(skill, harness);
      if (!target || typeof target.path !== 'string' || typeof target.renderer !== 'string') {
        throw new Error(`Skill ${skill.name} missing target metadata for ${harness}`);
      }
      if (!target.path.startsWith('{skillsRoot}/') || target.path.includes('..') || path.isAbsolute(target.path)) {
        throw new Error(`Skill ${skill.name} has unsafe target metadata for ${harness}`);
      }
    }
  }
  return captureSourceNames.size > 0 ? capturedSources : true;
}

function validateBundle() {
  const manifest = getManifest();
  const errors = [];
  const defaultSet = new Set(manifest.defaultSkills || []);
  const declaredSkillNames = new Set((manifest.skills || []).map((skill) => skill.name));

  try {
    assertProjectionManifest(manifest);
  } catch (error) {
    errors.push(error.message);
  }

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
    const skillPath = manifestSkillPath(skill);
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

const { createProjectionApi } = require('./projection');
const providerReconciliation = require('./provider-reconciliation');
const catalog = require('./catalog');
const catalogReconciliation = require('./reconciliation');
const harnessVerification = require('./harness-verification');
const collisionAlias = require('./collision-alias');
const receipts = require('./receipts');
const operator = require('./operator');
const config = require('./config');
const scheduler = require('./scheduler');
const doctor = require('./doctor');
const controlPlaneManager = require('./control-plane-manager');
const overlayAuthoring = require('./overlay-authoring');

const projection = createProjectionApi({
  assertProjectionManifest,
  getManifest,
  projectionMetadata,
  sha256,
});

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

  // The event is emitted only after every selected target has been copied and
  // its bytes can be re-read. A missing event root keeps the public package
  // usable in standalone/project-local installs; the machine-wide launcher
  // supplies JARVOS_SKILL_PROJECTION_EVENT_ROOT when it wants reconciliation.
  const event = emitInstallEvent({ manifest, names, destinationDir, installed, options });
  const eventRoot = options.eventRoot || process.env[SKILL_INSTALL_EVENT_ROOT_ENV];
  const eventTrigger = event && eventRoot ? triggerSkillProjection(eventRoot, options) : null;
  Object.defineProperty(installed, 'event', { value: event, enumerable: false, configurable: false });
  Object.defineProperty(installed, 'eventTrigger', { value: eventTrigger, enumerable: false, configurable: false });

  return installed;
}

module.exports = {
  DEFAULT_PACK_NAME,
  MODULE_ROOT,
  MANIFEST_PATH,
  PACKS_DIR,
  SKILL_INSTALL_EVENT_ROOT_ENV,
  SKILL_INSTALL_EVENT_VERSION,
  SKILL_PROJECTION_TRIGGER_ENV,
  assertPackManifest,
  assertProjectionManifest,
  applySkillProjection: projection.applySkillProjection,
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
  planSkillProjection: projection.planSkillProjection,
  stageProjectionPackage: projection.stageProjectionPackage,
  validateProjectionAdapter: projection.validateProjectionAdapter,
  getSkill,
  validateBundle,
  emitInstallEvent,
  triggerSkillProjection,
  resolveProjectionTrigger,
  installEventPayload,
  releaseTupleForInstall,
  manifestDigest,
  sourceCodeDigest,
  installSkills,
  ...providerReconciliation,
  CATALOG_SCHEMA_VERSION: catalog.CATALOG_SCHEMA_VERSION,
  OVERLAY_SCHEMA_VERSION: catalog.OVERLAY_SCHEMA_VERSION,
  EFFECTIVE_CATALOG_SCHEMA_VERSION: catalog.EFFECTIVE_CATALOG_SCHEMA_VERSION,
  PUBLIC_SOURCE_KIND: catalog.PUBLIC_SOURCE_KIND,
  LOCAL_OVERLAY_SOURCE_KIND: catalog.LOCAL_OVERLAY_SOURCE_KIND,
  SUPPORTED_HARNESSES: catalog.SUPPORTED_HARNESSES,
  catalogDigest: catalog.catalogDigest,
  computeBundleTree: catalog.computeBundleTree,
  validatePublicCatalog: catalog.validatePublicCatalog,
  validateLocalOverlay: catalog.validateLocalOverlay,
  composeEffectiveCatalog: catalog.composeEffectiveCatalog,
  attestCatalogBundle: catalog.attestCatalogBundle,
  redactEffectiveCatalog: catalog.redactEffectiveCatalog,
  assertPublicOnlyCatalog: catalog.assertPublicOnlyCatalog,
  planCatalogReconciliation: catalogReconciliation.planCatalogReconciliation,
  applyCatalogReconciliation: catalogReconciliation.applyCatalogReconciliation,
  verifyHarnessBundle: harnessVerification.verifyHarnessBundle,
  resolveCollisionAlias: collisionAlias.resolveCollisionAlias,
  safeAliasCandidates: collisionAlias.safeAliasCandidates,
  readReceipt: receipts.readReceipt,
  atomicWriteReceipt: receipts.atomicWriteReceipt,
  createSharedSkillManager: controlPlaneManager.createSharedSkillManager,
  admitOverlaySkill: overlayAuthoring.admitOverlaySkill,
  statusOperator: operator.statusOperator,
  planOperator: operator.planOperator,
  applyOperator: operator.applyOperator,
  refreshOperator: operator.refreshOperator,
  shareOperator: operator.shareOperator,
  enableHarness: operator.enableHarness,
  disableHarness: operator.disableHarness,
  renameAlias: operator.renameAlias,
  repairOperator: operator.repairOperator,
  schedulerOperator: operator.schedulerOperator,
  initOperator: operator.initOperator,
  loadConfig: config.loadConfig,
  saveConfig: config.saveConfig,
  defaultConfig: config.defaultConfig,
  planSchedulerUnits: scheduler.planSchedulerUnits,
  doctorSharedSkills: doctor.doctorSharedSkills,
};
