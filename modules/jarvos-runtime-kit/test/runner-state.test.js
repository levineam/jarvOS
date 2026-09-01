'use strict';

const assert = require('assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  JARVOS_RUNNER_STATE_RELATIVE_PATH,
  LEGACY_OPENCLAW_RUNNER_STATE_RELATIVE_PATH,
  RUNNER_STATE_VERSION,
  readRunnerState,
  resolveTelegramCredentialReference,
} = require('../src');

function fixtureRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-runner-state-'));
}

function writeState(root, relativePath, routes) {
  const target = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  fs.writeFileSync(target, `${JSON.stringify({ version: RUNNER_STATE_VERSION, routes })}\n`, { mode: 0o600 });
  return target;
}

const telegramRoute = Object.freeze({
  routeIdentity: 'telegram:owner-primary',
  secretStoreRef: 'keychain:jarvos/telegram-owner-primary',
  revision: 'credential-7',
});

test('jarvOS runner state wins over an equivalent legacy fixture without a fallback event', () => {
  const root = fixtureRoot();
  writeState(root, JARVOS_RUNNER_STATE_RELATIVE_PATH, [telegramRoute]);
  writeState(root, LEGACY_OPENCLAW_RUNNER_STATE_RELATIVE_PATH, [telegramRoute]);
  const events = [];

  const result = resolveTelegramCredentialReference({ fixtureRoot: root, logger: (event) => events.push(event) });
  assert.deepEqual(result, {
    ok: true,
    source: 'jarvos',
    compatibility: null,
    credential: telegramRoute,
  });
  assert.deepEqual(events, []);
});

test('legacy OpenClaw state is a logged read-only fallback and is never modified', () => {
  const root = fixtureRoot();
  const legacyPath = writeState(root, LEGACY_OPENCLAW_RUNNER_STATE_RELATIVE_PATH, [telegramRoute]);
  const before = fs.readFileSync(legacyPath, 'utf8');
  const events = [];

  const result = resolveTelegramCredentialReference({ fixtureRoot: root, logger: (event) => events.push(event) });
  assert.equal(result.ok, true);
  assert.equal(result.source, 'legacy-openclaw');
  assert.deepEqual(result.compatibility, { readOnly: true, migration: false });
  assert.deepEqual(result.credential, telegramRoute);
  assert.deepEqual(events, [{ event: 'jarvos.runner_state.legacy_fallback', source: 'legacy-openclaw', readOnly: true }]);
  assert.equal(fs.readFileSync(legacyPath, 'utf8'), before);
});

test('conflicting new and legacy Telegram routes fail closed', () => {
  const root = fixtureRoot();
  writeState(root, JARVOS_RUNNER_STATE_RELATIVE_PATH, [telegramRoute]);
  writeState(root, LEGACY_OPENCLAW_RUNNER_STATE_RELATIVE_PATH, [{ ...telegramRoute, revision: 'credential-8' }]);

  assert.deepEqual(resolveTelegramCredentialReference({ fixtureRoot: root }), {
    ok: false,
    code: 'runner_state_conflict',
  });
});

test('ambiguous Telegram routes, raw token fields, and symlinks fail closed without exposing values', (t) => {
  const ambiguous = fixtureRoot();
  writeState(ambiguous, JARVOS_RUNNER_STATE_RELATIVE_PATH, [telegramRoute, {
    ...telegramRoute,
    routeIdentity: 'telegram:secondary',
    secretStoreRef: 'keychain:jarvos/telegram-secondary',
  }]);
  assert.deepEqual(resolveTelegramCredentialReference({ fixtureRoot: ambiguous }), {
    ok: false,
    code: 'telegram_credential_reference_ambiguous',
  });

  const rawToken = fixtureRoot();
  const marker = 'fixture-raw-token-never-returned';
  const rawTarget = path.join(rawToken, JARVOS_RUNNER_STATE_RELATIVE_PATH);
  fs.mkdirSync(path.dirname(rawTarget), { recursive: true });
  fs.writeFileSync(rawTarget, JSON.stringify({ version: RUNNER_STATE_VERSION, routes: [{ ...telegramRoute, botToken: marker }] }));
  const rejected = readRunnerState({ fixtureRoot: rawToken });
  assert.deepEqual(rejected, { ok: false, code: 'runner_state_invalid' });
  assert.equal(JSON.stringify(rejected).includes(marker), false);

  const linked = fixtureRoot();
  const target = writeState(linked, 'target.json', [telegramRoute]);
  const linkPath = path.join(linked, JARVOS_RUNNER_STATE_RELATIVE_PATH);
  fs.mkdirSync(path.dirname(linkPath), { recursive: true });
  fs.symlinkSync(target, linkPath);
  assert.deepEqual(readRunnerState({ fixtureRoot: linked }), { ok: false, code: 'unsafe-path' });
  t.diagnostic('fixtures only: no live home directory, runtime, or credential store was consulted');
});

test('fixture root is mandatory; the resolver has no live-install default', () => {
  assert.deepEqual(readRunnerState(), { ok: false, code: 'fixture_root_required' });
});
