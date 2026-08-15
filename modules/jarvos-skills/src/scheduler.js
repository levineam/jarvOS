'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ensureDir, expandHome, collapseHome } = require('./config');

const LAUNCHD_LABEL_PREFIX = 'dev.jarvos.';
const SYSTEMD_SERVICE_SUFFIX = '.service';
const SYSTEMD_TIMER_SUFFIX = '.timer';

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function xmlEscape(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function resolveNodeExecutable(explicit) {
  if (explicit) return path.resolve(expandHome(explicit));
  return process.execPath;
}

function resolveCliScript(moduleRoot) {
  return path.resolve(moduleRoot, 'scripts', 'install-skills.js');
}

function buildRefreshCommand({ nodeExecutable, cliScript, configPath }) {
  return [
    shellQuote(nodeExecutable),
    shellQuote(cliScript),
    // This command performs a complete inventory generation before any repair.
    // It refuses mutations for incomplete observations and never enables itself.
    'autonomous-repair',
    '--config',
    shellQuote(configPath),
    '--json',
  ].join(' ');
}

function pathIsInside(parent, candidate) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

/**
 * Best-effort native watcher. Events only request a future complete cycle;
 * correctness always comes from the periodic complete inventory scan.
 */
function createInventoryWatcher({
  roots = [],
  suppressedPaths = [],
  debounceMs = 1_000,
  digestStabilityMs = 5_000,
  maxEvents = 256,
  onCycle,
  watch = fs.watch,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  if (typeof onCycle !== 'function') throw new Error('onCycle is required');
  if (!Number.isInteger(maxEvents) || maxEvents < 1) throw new Error('maxEvents must be positive');
  const queue = new Set();
  const watchers = [];
  let timer = null;
  let overflowed = false;
  let closed = false;
  const isSuppressed = (candidate) => suppressedPaths.some((item) => pathIsInside(item, candidate));
  const flush = () => {
    timer = null;
    if (closed) return;
    const events = [...queue].sort();
    queue.clear();
    const hadOverflow = overflowed;
    overflowed = false;
    onCycle({ reason: hadOverflow ? 'watcher_overflow' : 'root_event', events, overflowed: hadOverflow });
  };
  const request = (candidate) => {
    if (closed || (candidate && isSuppressed(candidate))) return false;
    if (queue.size >= maxEvents) overflowed = true;
    else if (candidate) queue.add(path.resolve(candidate));
    if (timer) clearTimer(timer);
    timer = setTimer(flush, debounceMs + digestStabilityMs);
    return true;
  };
  for (const root of roots) {
    try {
      if (!fs.existsSync(root)) continue;
      watchers.push(watch(root, { persistent: false }, (_event, filename) => request(filename ? path.join(root, filename) : root)));
    } catch {
      // A periodic run handles unavailable roots; request one bounded fallback.
      overflowed = true;
      request(root);
    }
  }
  return {
    request,
    close() {
      closed = true;
      if (timer) clearTimer(timer);
      for (const watcher of watchers) watcher.close();
    },
    get pending() { return queue.size; },
  };
}

function renderLaunchdPlist({
  label,
  nodeExecutable,
  cliScript,
  configPath,
  intervalMinutes,
  stdoutPath,
  stderrPath,
}) {
  const command = buildRefreshCommand({ nodeExecutable, cliScript, configPath });
  // launchd StartInterval is seconds.
  const seconds = intervalMinutes * 60;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/zsh</string>
    <string>-lc</string>
    <string>${xmlEscape(command)}</string>
  </array>
  <key>StartInterval</key>
  <integer>${seconds}</integer>
  <key>RunAtLoad</key>
  <false/>
  <key>StandardOutPath</key>
  <string>${stdoutPath}</string>
  <key>StandardErrorPath</key>
  <string>${stderrPath}</string>
</dict>
</plist>
`;
}

function renderSystemdUnits({
  unitName,
  nodeExecutable,
  cliScript,
  configPath,
  intervalMinutes,
}) {
  const command = buildRefreshCommand({ nodeExecutable, cliScript, configPath });
  const service = `[Unit]
Description=jarvOS shared-skill reconciliation (${unitName})

[Service]
Type=oneshot
ExecStart=/bin/sh -lc ${shellQuote(command)}
`;
  const timer = `[Unit]
Description=Timer for jarvOS shared-skill reconciliation (${unitName})

[Timer]
OnBootSec=5m
OnUnitActiveSec=${intervalMinutes}m
Persistent=true
Unit=${unitName}${SYSTEMD_SERVICE_SUFFIX}

[Install]
WantedBy=default.target
`;
  return { service, timer };
}

function planSchedulerUnits({
  platform = process.platform,
  home = os.homedir(),
  moduleRoot,
  configPath,
  unitName = 'jarvos-shared-skills',
  intervalMinutes = 60,
  nodeExecutable = null,
  write = false,
} = {}) {
  if (!moduleRoot) throw new Error('moduleRoot is required');
  if (!configPath) throw new Error('configPath is required');
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(unitName)) throw new Error('unitName is invalid');
  if (!Number.isInteger(intervalMinutes) || intervalMinutes < 5) {
    throw new Error('intervalMinutes must be an integer >= 5');
  }

  const node = resolveNodeExecutable(nodeExecutable);
  const cliScript = resolveCliScript(moduleRoot);
  const resolvedConfig = path.resolve(expandHome(configPath));
  const artifacts = [];

  if (platform === 'darwin') {
    const label = `${LAUNCHD_LABEL_PREFIX}${unitName}`;
    const agentsDir = path.join(home, 'Library', 'LaunchAgents');
    const plistPath = path.join(agentsDir, `${label}.plist`);
    const logDir = path.join(home, 'Library', 'Logs', 'jarvos');
    const content = renderLaunchdPlist({
      label,
      nodeExecutable: node,
      cliScript,
      configPath: resolvedConfig,
      intervalMinutes,
      stdoutPath: path.join(logDir, `${unitName}.out.log`),
      stderrPath: path.join(logDir, `${unitName}.err.log`),
    });
    artifacts.push({
      kind: 'launchd-plist',
      path: plistPath,
      content,
      enableCommand: `launchctl bootstrap gui/$(id -u) ${shellQuote(plistPath)}`,
      disableCommand: `launchctl bootout gui/$(id -u) ${shellQuote(label)}`,
    });
  } else if (platform === 'linux') {
    const userDir = path.join(home, '.config', 'systemd', 'user');
    const units = renderSystemdUnits({
      unitName,
      nodeExecutable: node,
      cliScript,
      configPath: resolvedConfig,
      intervalMinutes,
    });
    artifacts.push({
      kind: 'systemd-service',
      path: path.join(userDir, `${unitName}${SYSTEMD_SERVICE_SUFFIX}`),
      content: units.service,
      enableCommand: `systemctl --user enable --now ${unitName}${SYSTEMD_TIMER_SUFFIX}`,
      disableCommand: `systemctl --user disable --now ${unitName}${SYSTEMD_TIMER_SUFFIX}`,
    });
    artifacts.push({
      kind: 'systemd-timer',
      path: path.join(userDir, `${unitName}${SYSTEMD_TIMER_SUFFIX}`),
      content: units.timer,
      enableCommand: `systemctl --user enable --now ${unitName}${SYSTEMD_TIMER_SUFFIX}`,
      disableCommand: `systemctl --user disable --now ${unitName}${SYSTEMD_TIMER_SUFFIX}`,
    });
  } else {
    throw new Error(`scheduler units are not supported on platform: ${platform}`);
  }

  const written = [];
  if (write) {
    for (const artifact of artifacts) {
      ensureDir(path.dirname(artifact.path), 'scheduler unit directory');
      if (artifact.kind === 'launchd-plist') {
        ensureDir(path.dirname(artifact.content.includes('StandardOutPath')
          ? artifact.content.match(/<string>([^<]*\.out\.log)<\/string>/)?.[1] || path.join(home, 'Library', 'Logs', 'jarvos')
          : path.join(home, 'Library', 'Logs', 'jarvos')), 'scheduler log directory');
      }
      fs.writeFileSync(artifact.path, artifact.content, { mode: 0o600 });
      written.push(collapseHome(artifact.path));
    }
  }

  return {
    platform,
    unitName,
    intervalMinutes,
    configPath: collapseHome(resolvedConfig),
    write,
    enabled: false,
    note: 'Units are written disabled by default. Enable only after owner review.',
    artifacts: artifacts.map((artifact) => ({
      kind: artifact.kind,
      path: collapseHome(artifact.path),
      enableCommand: artifact.enableCommand,
      disableCommand: artifact.disableCommand,
      bytes: Buffer.byteLength(artifact.content),
    })),
    written,
  };
}

module.exports = {
  LAUNCHD_LABEL_PREFIX,
  planSchedulerUnits,
  renderLaunchdPlist,
  renderSystemdUnits,
  buildRefreshCommand,
  createInventoryWatcher,
};
