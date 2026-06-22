#!/usr/bin/env node
/**
 * Paperclip config resolver for jarvos-secondbrain bridge code.
 *
 * Reads process env first, then a shell-style env file. Values are returned for
 * callers to use, but this module never logs secrets.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { resolveConfig, expandTilde } = require('./resolve-config');

const PAPERCLIP_KEYS = [
  'PAPERCLIP_API_URL',
  'PAPERCLIP_API_KEY',
  'PAPERCLIP_COMPANY_ID',
  'PAPERCLIP_AGENT_ID',
  'PAPERCLIP_RUN_ID',
];

function stripQuotes(value) {
  const trimmed = String(value || '').trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function parseEnvFile(text) {
  const parsed = {};
  for (const line of String(text || '').split(/\r?\n/)) {
    const cleaned = line.trim();
    if (!cleaned || cleaned.startsWith('#')) continue;
    const match = cleaned.match(/^(?:export\s+)?([A-Z0-9_]+)=(.*)$/);
    if (!match) continue;
    parsed[match[1]] = stripQuotes(match[2]);
  }
  return parsed;
}

function readEnvFile(filePath) {
  try {
    return parseEnvFile(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return {};
  }
}

function resolvePaperclipConfig(options = {}) {
  const env = options.env || process.env;
  const config = resolveConfig(options);
  const home = options.homeDir || env.HOME;
  const envFile = options.envFile
    || env.PAPERCLIP_ENV_FILE
    || path.join(config.paths.workspace, 'config', 'paperclip-env.sh');
  const fileValues = readEnvFile(expandTilde(envFile, home));
  const values = {};

  for (const key of PAPERCLIP_KEYS) {
    values[key] = env[key] || fileValues[key] || '';
  }

  return {
    apiUrl: values.PAPERCLIP_API_URL,
    apiKey: values.PAPERCLIP_API_KEY,
    companyId: values.PAPERCLIP_COMPANY_ID,
    agentId: values.PAPERCLIP_AGENT_ID,
    runId: values.PAPERCLIP_RUN_ID,
    envFile,
    hasApiUrl: Boolean(values.PAPERCLIP_API_URL),
    hasApiKey: Boolean(values.PAPERCLIP_API_KEY),
  };
}

module.exports = {
  PAPERCLIP_KEYS,
  parseEnvFile,
  resolvePaperclipConfig,
};
