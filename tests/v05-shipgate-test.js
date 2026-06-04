#!/usr/bin/env node
'use strict';

// v0.5 ship-gate smoke (automated): proves a fresh workspace can install the
// v0-5-0 skill pack and that the public package then runs the portable coding
// executor end-to-end. This is the in-CI mirror of the live ship gate — it does
// NOT hit a real tracker/PR backend (the live run is captured separately), but it
// guarantees the install bundle + executor wiring stay working in the public repo.

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const SMOKE = path.join(ROOT, 'scripts', 'jarvos-v05-profile-smoke.js');

test('v0-5-0 pack installs into a fresh workspace and the executor smoke passes', () => {
  const skills = require(path.join(ROOT, 'modules', 'jarvos-skills', 'src'));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-shipgate-'));
  try {
    // 1. Fresh-workspace install of the v0.5.0 pack.
    const res = skills.initJarvosWorkspace({ packName: 'v0-5-0', workspaceRoot: tmp });
    assert.equal(res.writes.installedSkillsManifest, 'created', 'installed-skills manifest written');
    const manifestPath = path.join(tmp, '.jarvos', 'installed-skills', 'v0-5-0.json');
    assert.ok(fs.existsSync(manifestPath), 'v0-5-0 manifest exists');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    assert.equal(manifest.name, 'v0-5-0');
    const names = manifest.skills.map((s) => s.name);
    assert.ok(names.includes('coding') && names.includes('agent-context'), `skills: ${names.join(', ')}`);

    // 2. The executor smoke must pass against the installed workspace.
    const smoke = spawnSync(process.execPath, [SMOKE, '--workspace', tmp, '--json'], {
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
    });
    assert.equal(smoke.status, 0, smoke.stderr || smoke.stdout);
    const report = JSON.parse(smoke.stdout);
    assert.equal(report.ok, true, smoke.stdout);
    assert.equal(report.runTakeIssueToDoneStatus, 'completed');
    assert.ok(report.eventCount > 0, 'executor produced stage events');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('v0-5-0 and local-openclaw packs are valid manifests', () => {
  const skills = require(path.join(ROOT, 'modules', 'jarvos-skills', 'src'));
  for (const name of ['v0-5-0', 'local-openclaw', 'obsidian-default']) {
    const pack = skills.loadPack(name); // throws if the strict validator rejects it
    assert.equal(pack.name, name);
  }
});
