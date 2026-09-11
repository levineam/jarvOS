'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

let electronRuntime = null;

function setElectronRuntime(runtime) {
  electronRuntime = runtime || null;
}

function keyStorePath() {
  const baseDir = electronRuntime?.userDataPath || process.env.JARVOS_ELECTRON_USER_DATA_DIR ||
    path.join(os.homedir(), '.jarvos-desktop');
  return path.join(baseDir, 'openai-key.enc');
}

function encryptionAvailable() {
  const safeStorage = electronRuntime?.safeStorage;
  if (!safeStorage) return false;
  if (typeof safeStorage.isEncryptionAvailable !== 'function') return false;
  return safeStorage.isEncryptionAvailable();
}

function canStoreKey() {
  return Boolean(electronRuntime?.safeStorage && encryptionAvailable());
}

function resolveOpenAIKey() {
  if (process.env.OPENAI_API_KEY) {
    return { key: process.env.OPENAI_API_KEY, source: 'env' };
  }
  if (!canStoreKey()) return { key: null, source: 'none' };
  const file = keyStorePath();
  if (!fs.existsSync(file)) return { key: null, source: 'none' };
  try {
    const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
    const ciphertext = Buffer.from(stored.ciphertext || '', 'base64');
    const key = electronRuntime.safeStorage.decryptString(ciphertext);
    return key ? { key, source: 'keychain' } : { key: null, source: 'none' };
  } catch {
    return { key: null, source: 'none' };
  }
}

function status() {
  const resolved = resolveOpenAIKey();
  return {
    hasKey: Boolean(resolved.key),
    source: resolved.source,
    canStoreKey: canStoreKey(),
    encryptionAvailable: encryptionAvailable(),
  };
}

function saveOpenAIKey(key) {
  if (process.env.OPENAI_API_KEY) {
    return { saved: false, reason: 'OPENAI_API_KEY is set; env value takes precedence' };
  }
  if (!canStoreKey()) {
    const err = new Error('key storage requires Electron safeStorage; set OPENAI_API_KEY when running in browser mode');
    err.status = 400;
    throw err;
  }
  if (!key || typeof key !== 'string' || key.length < 12) {
    const err = new Error('valid OpenAI API key required');
    err.status = 400;
    throw err;
  }
  const file = keyStorePath();
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const ciphertext = electronRuntime.safeStorage.encryptString(key);
  fs.writeFileSync(file, JSON.stringify({ version: 1, ciphertext: ciphertext.toString('base64') }), { mode: 0o600 });
  return { saved: true };
}

function deleteOpenAIKey() {
  const file = keyStorePath();
  if (fs.existsSync(file)) fs.unlinkSync(file);
  return { deleted: true };
}

module.exports = {
  setElectronRuntime,
  resolveOpenAIKey,
  status,
  saveOpenAIKey,
  deleteOpenAIKey,
  keyStorePath,
};
