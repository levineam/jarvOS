#!/usr/bin/env node
'use strict';

/**
 * Maintainer live-preflight checklist for shared-skill distribution.
 *
 * This script is intentionally non-activating:
 * - never writes into real harness skill roots
 * - never enables launchd/systemd
 * - never sets remoteModelProbe=true
 * - never prints private skill bodies
 *
 * Default mode prints a machine-readable checklist with pass/fail/pending
 * evidence from local package gates only.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const MODULE_ROOT = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(MODULE_ROOT, '..', '..');

function run(command, args, opts = {}) {
  const result = spawnSync(command, args, {
    cwd: opts.cwd || REPO_ROOT,
    encoding: 'utf8',
    env: process.env,
  });
  return {
    ok: result.status === 0,
    status: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  };
}

function item(id, status, summary, evidence = null) {
  return { id, status, summary, evidence };
}

function main() {
  const args = new Set(process.argv.slice(2));
  const json = args.has('--json') || !args.has('--text');

  if (args.has('--help') || args.has('-h')) {
    process.stdout.write(`Usage:
  node modules/jarvos-skills/scripts/live-preflight-checklist.js [--json]

This command is always read-only. It never enables live harness gates or remote
model probes; use the installed-runtime activation procedure after merge.
`);
    process.exit(0);
  }

  if (args.has('--allow-writes')) {
    process.stderr.write('ERROR live-preflight-checklist is permanently read-only; --allow-writes is not supported\n');
    process.exit(2);
  }

  const items = [];

  // 1) Focused module tests
  const skillsTest = run(process.execPath, ['--test', 'test/*.test.js'], { cwd: MODULE_ROOT });
  items.push(item(
    'package-tests',
    skillsTest.ok ? 'pass' : 'fail',
    skillsTest.ok ? '@jarvos/skills tests green' : '@jarvos/skills tests failed',
    { exitCode: skillsTest.status },
  ));

  // 2) Runtime adapters
  const runtimeKit = run(process.execPath, [
    path.join(REPO_ROOT, 'modules/jarvos-runtime-kit/scripts/jarvos-runtime-kit.js'),
    'check',
    'all',
  ]);
  items.push(item(
    'runtime-adapters',
    runtimeKit.ok ? 'pass' : 'fail',
    runtimeKit.ok ? 'runtime-kit check all green' : 'runtime-kit check all failed',
    { exitCode: runtimeKit.status },
  ));

  // 3) Isolated matrix dogfood
  const dogfood = run(process.execPath, [
    path.join(MODULE_ROOT, 'scripts/dogfood-skills.js'),
    '--matrix',
    '--isolated',
  ]);
  let dogfoodBody = null;
  try { dogfoodBody = JSON.parse(dogfood.stdout); } catch { dogfoodBody = null; }
  items.push(item(
    'isolated-matrix-dogfood',
    dogfood.ok ? 'pass' : 'fail',
    dogfood.ok ? 'isolated four-harness dogfood pass' : 'isolated dogfood failed',
    dogfoodBody ? {
      applied: dogfoodBody.applied,
      pairs: (dogfoodBody.pairs || []).map((pair) => ({
        harness: pair.harness,
        verification: pair.verification,
        satisfied: pair.satisfied,
      })),
      secondRunNoop: dogfoodBody.secondRunNoop === true,
    } : { exitCode: dogfood.status },
  ));

  // 4) Shared-skill doctor (temp config, no owner home mutation beyond tmp)
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-live-preflight-'));
  fs.chmodSync(tmp, 0o700);
  const configPath = path.join(tmp, 'config.json');
  const controlRoot = path.join(tmp, 'control');
  try {
    const init = run(process.execPath, [
      path.join(MODULE_ROOT, 'scripts/install-skills.js'),
      'init-config',
      '--config',
      configPath,
      '--control-root',
      controlRoot,
      '--json',
    ]);
    const doctor = run(process.execPath, [
      path.join(MODULE_ROOT, 'scripts/install-skills.js'),
      'doctor-shared',
      '--config',
      configPath,
      '--control-root',
      controlRoot,
      '--json',
    ]);
    let doctorBody = null;
    try { doctorBody = JSON.parse(doctor.stdout); } catch { doctorBody = null; }
    items.push(item(
      'doctor-shared',
      init.ok && doctor.ok && doctorBody?.ok ? 'pass' : 'fail',
      doctorBody?.ok ? 'shared-skill doctor READY on fresh config' : 'shared-skill doctor not ready',
      doctorBody ? {
        ok: doctorBody.ok,
        checkCount: (doctorBody.checks || []).length,
        failing: (doctorBody.checks || []).filter((check) => !check.ok).map((check) => check.id),
      } : { exitCode: doctor.status },
    ));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  // 5) Owner-only live steps remain pending by design
  items.push(item(
    'claude-interactive-probe',
    'pending_owner',
    'Claude verificationTier is interactive-smoke; authorize a remote model probe only on the owner machine',
    { remoteModelProbe: false, liveGates: 'off' },
  ));
  items.push(item(
    'hermes-private-overlay',
    'pending_owner',
    'Private overlay + Hermes receipt-owned path must be dogfooded by the owner with redacted receipts',
    { publishPrivateBodies: false },
  ));
  items.push(item(
    'scheduler-enable',
    'pending_owner',
    'launchd/systemd units may be written disabled; enabling is an owner action after review',
    { autoEnable: false, readOnly: true },
  ));
  items.push(item(
    'live-harness-gates',
    'off',
    'Live harness activation remains intentionally off for this package path',
    { enabled: false },
  ));

  const blockingFail = items.some((entry) => entry.status === 'fail');
  const report = {
    ok: !blockingFail,
    mode: 'live-preflight-checklist',
    activating: false,
    readOnly: true,
    generatedAt: new Date().toISOString(),
    items,
    next: blockingFail
      ? 'Fix failing package gates before owner live dogfood.'
      : 'Package gates green. Owner may run Claude interactive probe and private Hermes overlay dogfood locally; keep live gates off until those receipts exist.',
  };

  if (json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    for (const entry of items) {
      process.stdout.write(`${entry.status.toUpperCase().padEnd(14)} ${entry.id} — ${entry.summary}\n`);
    }
    process.stdout.write(`\n${report.ok ? 'PACKAGE GATES READY' : 'PACKAGE GATES NOT READY'}\n`);
    process.stdout.write(`${report.next}\n`);
  }
  process.exit(blockingFail ? 1 : 0);
}

if (require.main === module) main();
