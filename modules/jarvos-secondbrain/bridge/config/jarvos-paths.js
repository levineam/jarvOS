#!/usr/bin/env node
/**
 * jarvos-paths.js — compatibility surface over the canonical resolveConfig.
 *
 * The jarvos-agent-context MCP (Claude/Codex) expects a jarvos-paths-style API
 * (getVaultDir/getJournalDir/getNotesDir/getClawdDir/getTimeZone). The canonical
 * pipeline here exposes resolveConfig() instead. This thin shim lets the MCP load
 * THIS (canonical) tree via JARVOS_SECONDBRAIN_DIR, so notes created from any tool
 * go through one pipeline — including the SUP-1884 fail-closed vault guards and all
 * v0.2.1/v0.3 behavior — instead of a diverged copy (WS7 cross-tool unification).
 */

'use strict';

const fs = require('fs');
const path = require('path');
const {
  discoverConfigPath,
  expandTilde: expandTildeWithHome,
  resolveConfig,
} = require('./src/resolve-config');

const DEFAULT_JOURNAL_MAINTENANCE_SCHEDULE = '1 0 * * *';

function expandTilde(value, home = process.env.HOME) {
  return expandTildeWithHome(value, home);
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return {};
  }
}

function currentConfig() {
  const configPath = discoverConfigPath();
  return readJson(configPath);
}

function validTimezone(value) {
  if (!value) return null;
  try {
    Intl.DateTimeFormat(undefined, { timeZone: value });
    return value;
  } catch {
    return null;
  }
}

function firstValidTimezone(values = []) {
  for (const value of values) {
    const timezone = validTimezone(value);
    if (timezone) return timezone;
  }
  return null;
}

function runtimeTimezone() {
  try {
    return validTimezone(Intl.DateTimeFormat().resolvedOptions().timeZone);
  } catch {
    return null;
  }
}

function userMdTimezone(workspaceDir = getClawdDir()) {
  try {
    const body = fs.readFileSync(path.join(workspaceDir, 'USER.md'), 'utf8');
    const lines = body.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const timezoneHeadingIndex = lines.findIndex((line) => /^#+\s+timezone$/i.test(line));
    if (timezoneHeadingIndex >= 0) return validTimezone(lines[timezoneHeadingIndex + 1]);
  } catch {
    // Optional local user metadata.
  }
  return null;
}

function paths(options = {}) {
  return resolveConfig(options).paths;
}

function getVaultDir(options = {}) {
  return paths(options).vault;
}

function getJournalDir(options = {}) {
  return paths(options).journal;
}

function getNotesDir(options = {}) {
  return paths(options).notes;
}

function getClawdDir(options = {}) {
  return paths(options).workspace;
}

function getTimeZone(options = {}) {
  const config = currentConfig();
  return firstValidTimezone([
    process.env.JARVOS_TIMEZONE,
    config.user?.timezone ||
    config.user?.timeZone,
    config.timezone,
    config.timeZone,
    process.env.TZ,
  ]) || runtimeTimezone() || 'UTC';
}

function getJournalMaintenanceSchedule() {
  const config = currentConfig();
  return (
    process.env.JARVOS_JOURNAL_MAINTENANCE_SCHEDULE ||
    config.jobs?.journalMaintenance?.schedule ||
    DEFAULT_JOURNAL_MAINTENANCE_SCHEDULE
  );
}

function getJournalMaintenanceTimeZone(overrides = {}) {
  const config = currentConfig();
  return firstValidTimezone([
    overrides.timezone,
    overrides.timeZone,
    process.env.JARVOS_JOURNAL_MAINTENANCE_TIMEZONE,
    config.jobs?.journalMaintenance?.timezone,
    config.jobs?.journalMaintenance?.timeZone,
    process.env.JARVOS_TIMEZONE,
    config.user?.timezone,
    config.user?.timeZone,
    config.timezone,
    config.timeZone,
    userMdTimezone(),
    process.env.TZ,
  ]) || runtimeTimezone() || 'UTC';
}

function resetConfigCache() {
  // Compatibility with older callers. The public resolver is currently stateless.
}

module.exports = {
  getVaultDir,
  getJournalDir,
  getNotesDir,
  getClawdDir,
  expandTilde,
  getJournalMaintenanceSchedule,
  getJournalMaintenanceTimeZone,
  getTimeZone,
  resetConfigCache,
};
