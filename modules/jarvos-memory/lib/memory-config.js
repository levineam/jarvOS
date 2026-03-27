'use strict';

const os = require('os');
const path = require('path');

const DEFAULT_CLAWD_ROOT = path.join(os.homedir(), 'clawd');

function getClawdRoot() {
  return process.env.CLAWD_DIR || DEFAULT_CLAWD_ROOT;
}

function getMemoryPaths() {
  const clawdRoot = getClawdRoot();
  return {
    clawdRoot,
    memoryRegistryFile: path.join(clawdRoot, 'MEMORY.md'),
    decisionsDir: path.join(clawdRoot, 'memory', 'decisions'),
    lessonsDir: path.join(clawdRoot, 'memory', 'lessons'),
    projectsDir: path.join(clawdRoot, 'memory', 'projects'),
    dailyLogDir: path.join(clawdRoot, 'memory'),
  };
}

module.exports = {
  DEFAULT_CLAWD_ROOT,
  getClawdRoot,
  getMemoryPaths,
};
