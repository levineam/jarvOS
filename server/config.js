'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

function expandTilde(value) {
  if (typeof value !== 'string') return value;
  if (value === '~') return os.homedir();
  if (value.startsWith('~/')) return path.join(os.homedir(), value.slice(2));
  return value;
}

function expandDeep(value) {
  if (typeof value === 'string') return expandTilde(value);
  if (Array.isArray(value)) return value.map(expandDeep);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = expandDeep(v);
    return out;
  }
  return value;
}

function loadConfig() {
  const configPath = path.join(__dirname, '..', 'config.json');
  const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  return expandDeep(raw);
}

module.exports = { loadConfig, expandTilde };
