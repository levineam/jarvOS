'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const docs = {
  runtime: fs.readFileSync(path.join(ROOT, 'runtimes/openclaw/README.md'), 'utf8'),
  profile: fs.readFileSync(path.join(ROOT, 'modules/jarvos/docs/local-openclaw-profile.md'), 'utf8'),
  hygiene: fs.readFileSync(path.join(ROOT, 'modules/jarvos/docs/maintenance-hygiene.md'), 'utf8'),
  module: fs.readFileSync(path.join(ROOT, 'modules/jarvos/README.md'), 'utf8'),
};

test('OpenClaw docs make registry-derived durable roots authoritative', () => {
  for (const [name, content] of Object.entries(docs)) {
    assert.doesNotMatch(content, /\/Users\/|clawd-worktrees|f1a312bc08|931facd395/, `${name} must not contain private incident material`);
  }
  assert.match(docs.runtime, /durable software, not cache/i);
  assert.match(docs.runtime, /plugins registry --json/);
  assert.match(docs.runtime, /plugins inspect --all --json/);
  assert.match(docs.runtime, /installation-specific/);
  assert.match(docs.runtime, /generated registry database or index/);
  assert.match(docs.hygiene, /OpenClaw npm\/project tree/i);
  assert.match(docs.hygiene, /registry output is the\s+authority/i);
  assert.match(docs.hygiene, /preflight and post-cleanup inspection/i);
});

test('OpenClaw docs keep cleanup and recovery non-mutating by default', () => {
  assert.match(docs.runtime, /official OpenClaw command/i);
  assert.match(docs.runtime, /plugins install <package-or-path>/);
  assert.match(docs.runtime, /plugins enable <plugin-id>/);
  assert.match(docs.runtime, /do not.*broad automatic repair/is);
  assert.match(docs.profile, /plugin-persistence check/);
  assert.match(docs.profile, /Missing user-managed records, paths, manifests/);
  assert.match(docs.profile, /missing enabled jarvOS staged adapter is\s+a failure/i);
  assert.match(docs.profile, /Do not edit generated registry state/);
  assert.match(docs.hygiene, /Do not ask jarvOS to reinstall arbitrary user plugins/);
});

test('OpenClaw docs distinguish portable init from managed setup writes', () => {
  assert.match(docs.profile, /jarvos init.*ordinary local profile/is);
  assert.match(docs.profile, /runtimes\/openclaw\/setup\.sh/);
  assert.match(docs.profile, /backs up before writing/);
  assert.match(docs.profile, /restores the exact prior bytes, mode, and presence/is);
  assert.match(docs.module, /jarvOS init` does not create or/);
  assert.match(docs.module, /transactional and rollback-aware/);
  assert.match(docs.runtime, /does not install the staged jarvOS plugin into an OpenClaw-managed/);
});
