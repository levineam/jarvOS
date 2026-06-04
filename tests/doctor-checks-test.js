#!/usr/bin/env node
'use strict';

// Unit coverage for the SUP-2262 doctor checks: vault-path-stale and journal-conflict.
// These guard the SUP-2269 failure mode (a stale/moved vault, or Obsidian's own journal
// automation writing into the same folder jarvOS journals into and clobbering it).

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');

const { checkVaultPathStale, checkJournalConflict } = require('../lib/jarvos-cli');

function scratch() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-doctor-'));
}

function writeConfig(dir, config) {
  const configPath = path.join(dir, 'jarvos.config.json');
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  return configPath;
}

function makeVault(root, { obsidian = false, journalDir = true } = {}) {
  fs.mkdirSync(root, { recursive: true });
  if (journalDir) fs.mkdirSync(path.join(root, 'Journal'), { recursive: true });
  if (obsidian) fs.mkdirSync(path.join(root, '.obsidian'), { recursive: true });
  return root;
}

test('vault-path-stale passes for an existing vault root', () => {
  const tmp = scratch();
  try {
    const vault = makeVault(path.join(tmp, 'vault'));
    const configPath = writeConfig(tmp, { vaultPath: vault });
    const res = checkVaultPathStale(configPath);
    assert.equal(res.ok, true, res.detail);
    assert.equal(res.id, 'vault-path-stale');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('vault-path-stale fails when the configured vault root is gone', () => {
  const tmp = scratch();
  try {
    const configPath = writeConfig(tmp, { vaultPath: path.join(tmp, 'moved-away') });
    const res = checkVaultPathStale(configPath);
    assert.equal(res.ok, false);
    assert.match(res.detail, /does not exist \(stale or moved vault\)/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('vault-path-stale fails when vaultPath is unset', () => {
  const tmp = scratch();
  try {
    const configPath = writeConfig(tmp, {});
    const res = checkVaultPathStale(configPath);
    assert.equal(res.ok, false);
    assert.match(res.detail, /not configured/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('journal-conflict passes when there is no .obsidian config', () => {
  const tmp = scratch();
  try {
    const vault = makeVault(path.join(tmp, 'vault'));
    const configPath = writeConfig(tmp, { vaultPath: vault });
    const res = checkJournalConflict(configPath);
    assert.equal(res.ok, true, res.detail);
    assert.match(res.detail, /sole journal writer/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('journal-conflict fails when the Obsidian "journals" community plugin is enabled', () => {
  const tmp = scratch();
  try {
    const vault = makeVault(path.join(tmp, 'vault'), { obsidian: true });
    fs.writeFileSync(path.join(vault, '.obsidian', 'community-plugins.json'), JSON.stringify(['dataview', 'journals']));
    const configPath = writeConfig(tmp, { vaultPath: vault });
    const res = checkJournalConflict(configPath);
    assert.equal(res.ok, false);
    assert.match(res.detail, /"journals" is enabled/);
    assert.match(res.detail, /SUP-2269/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('journal-conflict fails when core daily-notes writes into the jarvOS Journal folder', () => {
  const tmp = scratch();
  try {
    const vault = makeVault(path.join(tmp, 'vault'), { obsidian: true });
    fs.writeFileSync(path.join(vault, '.obsidian', 'core-plugins.json'), JSON.stringify(['daily-notes']));
    fs.writeFileSync(path.join(vault, '.obsidian', 'daily-notes.json'), JSON.stringify({ folder: 'Journal' }));
    const configPath = writeConfig(tmp, { vaultPath: vault });
    const res = checkJournalConflict(configPath);
    assert.equal(res.ok, false);
    assert.match(res.detail, /daily-notes.*overlapping jarvOS Journal/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('journal-conflict ignores a daily-notes folder that does not overlap Journal', () => {
  const tmp = scratch();
  try {
    const vault = makeVault(path.join(tmp, 'vault'), { obsidian: true });
    fs.writeFileSync(path.join(vault, '.obsidian', 'core-plugins.json'), JSON.stringify(['daily-notes']));
    fs.writeFileSync(path.join(vault, '.obsidian', 'daily-notes.json'), JSON.stringify({ folder: 'Daily' }));
    const configPath = writeConfig(tmp, { vaultPath: vault });
    const res = checkJournalConflict(configPath);
    assert.equal(res.ok, true, res.detail);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
