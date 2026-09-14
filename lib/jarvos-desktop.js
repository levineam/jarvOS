'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync: defaultSpawnSync } = require('child_process');

const SOURCE_ROOT = path.resolve(__dirname, '..', 'apps', 'desktop');
const MIN_NODE = [22, 12];
const SUPPORTED_PLATFORMS = new Set(['darwin', 'linux', 'win32']);
const REQUIRED_ASSETS = [
  'package.json', 'package-lock.json', 'config.default.json', 'electron/main.js',
  'server/index.js', 'static/index.html', 'static/app.js', 'static/style.css',
  'static/chat/chat.js', 'static/chat/style.css',
];
const MACOS_SYSTEM_PARENT_ALIASES = new Map([
  ['/tmp', '/private/tmp'],
  ['/var', '/private/var'],
]);
const EXCLUDED_SOURCE_NAMES = new Set(['.git', 'node_modules', 'config.json']);

function optionsWithDefaults(options = {}) {
  if (!options.workspace) throw new Error('Desktop workspace is required');
  return {
    ...options,
    workspace: path.resolve(options.workspace),
    sourceRoot: path.resolve(options.sourceRoot || SOURCE_ROOT),
    env: options.env || process.env,
    nodeVersion: options.nodeVersion || process.versions.node,
    platform: options.platform || process.platform,
    spawnSync: options.spawnSync || defaultSpawnSync,
    npmCommand: options.npmCommand || 'npm',
  };
}

function isAllowedMacOSSystemParentAlias(component, target) {
  if (process.platform !== 'darwin' || component === target) return false;
  const expected = MACOS_SYSTEM_PARENT_ALIASES.get(component);
  if (!expected) return false;
  try { return fs.realpathSync(component) === expected; } catch { return false; }
}

function assertSafePathComponents(target, label) {
  const absolute = path.resolve(target);
  const root = path.parse(absolute).root;
  let current = root;
  let missing = false;
  for (const part of absolute.slice(root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    if (missing) continue;
    let stat;
    try { stat = fs.lstatSync(current); } catch (error) {
      if (error.code === 'ENOENT') { missing = true; continue; }
      throw new Error(`${label} is unreadable at ${current}`);
    }
    if (stat.isSymbolicLink() && !isAllowedMacOSSystemParentAlias(current, absolute)) {
      throw new Error(`${label} is symlinked at ${current}`);
    }
  }
}

function assertSafeFile(file, label, { required = true } = {}) {
  assertSafePathComponents(path.dirname(file), `${label} parent`);
  const stat = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!stat) {
    if (required) throw new Error(`${label} is missing at ${file}`);
    return null;
  }
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) {
    throw new Error(`${label} is symlinked, hardlinked, or not a regular file at ${file}`);
  }
  return stat;
}

function assertSafeDirectory(directory, label, { required = true } = {}) {
  assertSafePathComponents(path.dirname(directory), `${label} parent`);
  const stat = fs.lstatSync(directory, { throwIfNoEntry: false });
  if (!stat) {
    if (required) throw new Error(`${label} is missing at ${directory}`);
    return null;
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`${label} is symlinked or not a directory at ${directory}`);
  return stat;
}

function assertSafeTree(root, label, { required = true } = {}) {
  const rootStat = assertSafeDirectory(root, label, { required });
  if (!rootStat) return [];
  const files = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (isExcludedSourceName(entry.name)) continue;
    const full = path.join(root, entry.name);
    const stat = fs.lstatSync(full);
    if (stat.isSymbolicLink()) throw new Error(`${label} contains a symlink at ${full}`);
    if (stat.isDirectory()) files.push(...assertSafeTree(full, label));
    else if (stat.isFile()) {
      if (stat.nlink !== 1) throw new Error(`${label} contains a hardlinked file at ${full}`);
      files.push(full);
    } else {
      throw new Error(`${label} contains an unsupported entry at ${full}`);
    }
  }
  return files;
}

function isExcludedSourceName(name) {
  return EXCLUDED_SOURCE_NAMES.has(name);
}

function ensureSafeDirectory(directory, label) {
  assertSafePathComponents(path.dirname(directory), `${label} parent`);
  const existing = fs.lstatSync(directory, { throwIfNoEntry: false });
  if (existing) {
    if (existing.isSymbolicLink() || !existing.isDirectory()) throw new Error(`${label} is symlinked or not a directory at ${directory}`);
    return;
  }
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  assertSafeDirectory(directory, label);
}

function versionAtLeast(value) {
  const found = String(value || '').match(/^(\d+)\.(\d+)/);
  return Boolean(found) && (Number(found[1]) > MIN_NODE[0]
    || (Number(found[1]) === MIN_NODE[0] && Number(found[2]) >= MIN_NODE[1]));
}

function desktopPaths(workspace) {
  const root = path.join(workspace, '.jarvos', 'desktop');
  return {
    root,
    versions: path.join(root, 'versions'),
    current: path.join(root, 'CURRENT'),
    config: path.join(root, 'config.json'),
    lock: path.join(root, '.install.lock'),
  };
}

function contentId(sourceRoot) {
  const hash = crypto.createHash('sha256');
  for (const file of assertSafeTree(sourceRoot, 'Desktop source').sort()) {
    const relative = path.relative(sourceRoot, file).split(path.sep).join('/');
    hash.update(relative); hash.update('\0'); hash.update(fs.readFileSync(file)); hash.update('\0');
  }
  return hash.digest('hex');
}

function assertRequiredAssets(root, label) {
  assertSafeTree(root, label);
  for (const asset of REQUIRED_ASSETS) assertSafeFile(path.join(root, asset), `${label} asset`);
}

function electronPath(appPath, platform) {
  if (platform === 'darwin') return path.join(appPath, 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron');
  return path.join(appPath, 'node_modules', 'electron', 'dist', platform === 'win32' ? 'electron.exe' : 'electron');
}

function assertReadyApp(appPath, platform, label = 'Installed Desktop') {
  assertRequiredAssets(appPath, label);
  const executable = electronPath(appPath, platform);
  assertSafeFile(executable, `${label} Electron executable`);
  if (platform !== 'win32') fs.accessSync(executable, fs.constants.X_OK);
  return executable;
}

function readCurrent(paths) {
  const current = assertSafeFile(paths.current, 'Desktop selection', { required: false });
  if (!current) return null;
  const id = fs.readFileSync(paths.current, 'utf8').trim();
  if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('Desktop selection is malformed');
  return id;
}

function readWorkspaceConfig(workspace) {
  const file = path.join(workspace, 'jarvos.config.json');
  assertSafeFile(file, 'jarvOS workspace configuration');
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { throw new Error('jarvOS workspace configuration is malformed'); }
}

function resolveVault(options) {
  if (options.vault) return path.resolve(expandHome(options.vault));
  const config = readWorkspaceConfig(options.workspace);
  const candidate = config.paths?.vault || config.vaultPath;
  if (typeof candidate !== 'string' || !candidate.trim()) return null;
  const expanded = expandHome(candidate);
  return path.resolve(path.isAbsolute(expanded) ? expanded : path.join(options.workspace, expanded));
}

function expandHome(value) {
  if (value === '~') return os.homedir();
  return value.startsWith('~/') ? path.join(os.homedir(), value.slice(2)) : value;
}

function buildConfig(options) {
  const defaults = JSON.parse(fs.readFileSync(path.join(options.sourceRoot, 'config.default.json'), 'utf8'));
  const vault = resolveVault(options);
  if (vault) defaults.vault = {
    ...defaults.vault,
    root: vault,
    journalDir: path.join(vault, 'Journal'),
    notesDir: path.join(vault, 'Notes'),
  };
  defaults.systemDoctor = { ...defaults.systemDoctor, workspace: options.workspace };
  return `${JSON.stringify(defaults, null, 2)}\n`;
}

function preflightDesktop(input = {}) {
  const options = optionsWithDefaults(input);
  if (!versionAtLeast(options.nodeVersion)) {
    throw new Error('Desktop requires Node.js 22.12+; use --no-desktop or JARVOS_NO_DESKTOP=1 for core-only Node 18');
  }
  if (!SUPPORTED_PLATFORMS.has(options.platform)) throw new Error(`Desktop is unsupported on ${options.platform}; use --no-desktop or JARVOS_NO_DESKTOP=1`);
  const npm = options.spawnSync(options.npmCommand, ['--version'], { encoding: 'utf8', env: options.env });
  if (npm?.error || npm?.status !== 0) throw new Error('Desktop requires npm; use --no-desktop or JARVOS_NO_DESKTOP=1 for core-only installation');
  assertSafePathComponents(options.workspace, 'Desktop workspace');
  const paths = desktopPaths(options.workspace);
  assertSafePathComponents(paths.root, 'Desktop installation path');
  assertSafeTree(options.sourceRoot, 'Desktop source');
  assertRequiredAssets(options.sourceRoot, 'Desktop source');
  assertSafeFile(paths.config, 'Desktop configuration', { required: false });
  assertSafeFile(paths.current, 'Desktop selection', { required: false });
  return { workspace: options.workspace, sourceRoot: options.sourceRoot, platform: options.platform, nodeVersion: options.nodeVersion, npm: options.npmCommand };
}

function lockRecord(file, label) {
  assertSafeFile(file, label);
  let record;
  try { record = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { throw new Error(`${label} is malformed; refusing concurrent installation`); }
  if (!Number.isInteger(record.pid) || record.pid < 1 || typeof record.token !== 'string' || !record.token) {
    throw new Error(`${label} is malformed; refusing concurrent installation`);
  }
  return record;
}

function writeLock(file, record, label) {
  const fd = fs.openSync(file, 'wx', 0o600);
  try { fs.writeFileSync(fd, `${JSON.stringify(record)}\n`); } finally { fs.closeSync(fd); }
  assertSafeFile(file, label);
}

function releaseOwnedLock(file, token, label) {
  try {
    if (lockRecord(file, label).token === token) fs.unlinkSync(file);
  } catch {}
}

function isDeadOwner(record) {
  try { process.kill(record.pid, 0); return false; } catch (error) {
    if (error?.code === 'ESRCH') return true;
    throw error;
  }
}

function recoverStaleLock(paths, record, owner) {
  const recovery = `${paths.lock}.recovery`;
  const recoveryToken = crypto.randomUUID();
  try { writeLock(recovery, { pid: process.pid, token: recoveryToken, startedAt: new Date().toISOString() }, 'Desktop install recovery lock'); } catch (error) {
    if (error.code === 'EEXIST') throw new Error('Desktop stale lock recovery is already in progress; refusing concurrent installation');
    throw error;
  }
  try {
    const current = lockRecord(paths.lock, 'Desktop install lock');
    if (current.token !== record.token || current.pid !== record.pid || !isDeadOwner(current)) {
      throw new Error('Desktop install lock changed while recovering; refusing concurrent installation');
    }
    const confirmed = lockRecord(paths.lock, 'Desktop install lock');
    if (confirmed.token !== record.token || confirmed.pid !== record.pid || !isDeadOwner(confirmed)) {
      throw new Error('Desktop install lock changed while recovering; refusing concurrent installation');
    }
    fs.unlinkSync(paths.lock);
    writeLock(paths.lock, owner, 'Desktop install lock');
  } finally {
    releaseOwnedLock(recovery, recoveryToken, 'Desktop install recovery lock');
  }
}

function withInstallLock(paths, callback) {
  ensureSafeDirectory(paths.root, 'Desktop installation directory');
  const owner = { pid: process.pid, token: crypto.randomUUID(), startedAt: new Date().toISOString() };
  let acquired = false;
  try {
    try {
      writeLock(paths.lock, owner, 'Desktop install lock'); acquired = true;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const stale = lockRecord(paths.lock, 'Desktop install lock');
      if (!isDeadOwner(stale)) throw new Error(`Desktop installation is already running (pid ${stale.pid})`);
      recoverStaleLock(paths, stale, owner); acquired = true;
    }
    return callback();
  } finally {
    if (acquired) {
      releaseOwnedLock(paths.lock, owner.token, 'Desktop install lock');
    }
  }
}

function copySource(sourceRoot, staging) {
  for (const entry of fs.readdirSync(sourceRoot, { withFileTypes: true })) {
    if (isExcludedSourceName(entry.name)) continue;
    fs.cpSync(path.join(sourceRoot, entry.name), path.join(staging, entry.name), {
      recursive: true,
      filter(source) { return !isExcludedSourceName(path.basename(source)); },
    });
  }
}

function electronInstallEnv(env) {
  const clean = { ...env };
  for (const key of [
    'ELECTRON_OVERRIDE_DIST_PATH', 'ELECTRON_OVERRIDE_DIST_URL', 'ELECTRON_PLATFORM', 'ELECTRON_ARCH',
    'ELECTRON_INSTALL_PLATFORM', 'ELECTRON_INSTALL_ARCH', 'ELECTRON_SKIP_BINARY_DOWNLOAD', 'npm_config_platform', 'npm_config_arch',
    'npm_config_target_platform', 'npm_config_target_arch',
  ]) delete clean[key];
  return clean;
}

function writeConfigIfAbsent(paths, options) {
  const existing = assertSafeFile(paths.config, 'Desktop configuration', { required: false });
  if (existing) {
    readDesktopConfig(paths.config);
    return false;
  }
  const temporary = path.join(paths.root, `.config.${crypto.randomUUID()}.tmp`);
  fs.writeFileSync(temporary, buildConfig(options), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  try {
    assertSafePathComponents(paths.root, 'Desktop installation directory');
    try { fs.linkSync(temporary, paths.config); } catch (error) {
      if (error.code === 'EEXIST') throw new Error('Desktop configuration appeared during installation; refusing to overwrite it');
      throw error;
    }
  } finally {
    try { fs.unlinkSync(temporary); } catch {}
  }
  fs.chmodSync(paths.config, 0o600);
  return true;
}

function readDesktopConfig(file) {
  let config;
  try { config = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { throw new Error('Desktop configuration is malformed; refusing to overwrite it'); }
  if (!config || Array.isArray(config) || typeof config !== 'object') throw new Error('Desktop configuration must be a JSON object');
  return config;
}

function selectCurrent(paths, id) {
  const temporary = path.join(paths.root, `.CURRENT.${crypto.randomUUID()}.tmp`);
  fs.writeFileSync(temporary, `${id}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  try {
    assertSafePathComponents(paths.root, 'Desktop installation directory');
    assertSafeFile(paths.current, 'Desktop selection', { required: false });
    fs.renameSync(temporary, paths.current);
  } finally {
    try { fs.unlinkSync(temporary); } catch {}
  }
}

function installDesktop(input = {}) {
  const options = optionsWithDefaults(input);
  preflightDesktop(options);
  readWorkspaceConfig(options.workspace);
  const paths = desktopPaths(options.workspace);
  return withInstallLock(paths, () => {
    ensureSafeDirectory(paths.versions, 'Desktop versions directory');
    const id = contentId(options.sourceRoot);
    const appPath = path.join(paths.versions, id);
    let installed = false;
    let changed = false;
    const selected = readCurrent(paths);
    const existing = fs.lstatSync(appPath, { throwIfNoEntry: false });
    if (existing) {
      assertSafeDirectory(appPath, 'Desktop version');
      assertReadyApp(appPath, options.platform, 'Installed Desktop');
    } else {
      const staging = path.join(paths.root, `.staging-${id}-${process.pid}-${crypto.randomUUID()}`);
      const stagingOwner = `${staging}.owner`;
      const stagingToken = crypto.randomUUID();
      let committed = false;
      try {
        fs.mkdirSync(staging, { mode: 0o700 });
        fs.writeFileSync(stagingOwner, `${stagingToken}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
        copySource(options.sourceRoot, staging);
        const result = options.spawnSync(options.npmCommand, ['ci', '--include=dev'], {
          cwd: staging,
          encoding: 'utf8',
          env: { ...electronInstallEnv(options.env), npm_config_production: 'false' },
        });
        if (result?.error || result?.status !== 0) throw new Error(`Desktop dependency installation failed${result?.error ? `: ${result.error.message}` : ''}`);
        const electronInstall = options.spawnSync(process.execPath, [path.join(staging, 'node_modules', 'electron', 'install.js')], {
          cwd: staging,
          encoding: 'utf8',
          env: electronInstallEnv(options.env),
        });
        if (electronInstall?.error || electronInstall?.status !== 0) throw new Error(`Desktop Electron installation failed${electronInstall?.error ? `: ${electronInstall.error.message}` : ''}`);
        assertReadyApp(staging, options.platform, 'Staged Desktop');
        fs.renameSync(staging, appPath);
        committed = true;
      } finally {
        if (!committed) {
          try {
            assertSafeDirectory(staging, 'Desktop staging directory');
            if (assertSafeFile(stagingOwner, 'Desktop staging ownership marker')
              && fs.readFileSync(stagingOwner, 'utf8').trim() === stagingToken) fs.rmSync(staging, { recursive: true, force: false });
          } catch {}
        }
        try {
          if (assertSafeFile(stagingOwner, 'Desktop staging ownership marker', { required: false })
            && fs.readFileSync(stagingOwner, 'utf8').trim() === stagingToken) fs.unlinkSync(stagingOwner);
        } catch {}
      }
      installed = true;
    }
    const createdConfig = writeConfigIfAbsent(paths, options);
    try {
      if (selected !== id) { selectCurrent(paths, id); changed = true; }
    } catch (error) {
      if (createdConfig) { try { fs.unlinkSync(paths.config); } catch {} }
      throw error;
    }
    return { installed, changed: changed || createdConfig, id, content: `sha256:${id}`, version: id, appPath, configPath: paths.config };
  });
}

function desktopStatus(input = {}) {
  let options;
  try {
    options = optionsWithDefaults(input);
    const paths = desktopPaths(options.workspace);
    assertSafePathComponents(paths.root, 'Desktop installation path');
    const id = readCurrent(paths);
    const config = assertSafeFile(paths.config, 'Desktop configuration', { required: false });
    if (config) readDesktopConfig(paths.config);
    if (!id) return { installed: false, ready: false, id: null, content: null, version: null, appPath: null, configPath: paths.config, problem: 'Desktop is not installed' };
    const appPath = path.join(paths.versions, id);
    const executable = assertReadyApp(appPath, options.platform, 'Installed Desktop');
    if (!config) return { installed: true, ready: false, id, content: `sha256:${id}`, version: id, appPath, configPath: paths.config, problem: 'Desktop configuration is missing' };
    return { installed: true, ready: true, id, content: `sha256:${id}`, version: id, appPath, configPath: paths.config, electronPath: executable, problem: null };
  } catch (error) {
    const configPath = options ? desktopPaths(options.workspace).config : null;
    return { installed: false, ready: false, id: null, content: null, version: null, appPath: null, configPath, problem: error.message };
  }
}

function launchDesktop(input = {}) {
  const options = optionsWithDefaults(input);
  const status = desktopStatus(options);
  if (!status.ready) throw new Error(`Desktop is not ready: ${status.problem}`);
  const result = options.spawnSync(status.electronPath, [status.appPath], {
    cwd: status.appPath,
    env: {
      ...options.env,
      JARVOS_DESKTOP_CONFIG: status.configPath,
      JARVOS_ELECTRON_USER_DATA_DIR: options.env.JARVOS_ELECTRON_USER_DATA_DIR || path.join(options.workspace, '.jarvos', 'desktop', 'user-data'),
    },
    shell: false,
    stdio: 'inherit',
  });
  return { ...status, launched: !result?.error && result?.status === 0, exitCode: result?.status ?? null, result };
}

module.exports = { preflightDesktop, installDesktop, desktopStatus, launchDesktop };
