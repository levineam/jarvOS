'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  CODING_TOOL_SOURCE_TOOLS,
  SOURCE_TOOLS,
} = require('../packages/jarvos-ambient/src/intent/capture-contract');

const secondbrainRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(secondbrainRoot, '..', '..');

function readFromSecondbrain(relativePath) {
  return fs.readFileSync(path.join(secondbrainRoot, relativePath), 'utf8');
}

function readFromRepo(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

test('active CaptureEvent source constants are scoped to AI coding tools', () => {
  assert.deepEqual(
    CODING_TOOL_SOURCE_TOOLS,
    ['openclaw', 'codex', 'claude-code', 'hermes'],
  );

  for (const source of CODING_TOOL_SOURCE_TOOLS) {
    assert.ok(SOURCE_TOOLS.includes(source), `${source} must be accepted by CaptureEvent v2`);
  }

  assert.equal(SOURCE_TOOLS.includes('chatgpt'), false);
  assert.equal(SOURCE_TOOLS.includes('claude-app'), false);
});

test('secondbrain current-target docs do not list general chat apps as active sources', () => {
  const docs = [
    'README.md',
    'bridge/capture/README.md',
    'bridge/routing/README.md',
    'docs/architecture/automatic-secondbrain-public-boundary.md',
    'docs/contracts/CODING_TOOL_DETERMINISM.md',
    'docs/contracts/SESSION_SOURCE_ADAPTERS.md',
  ];

  for (const docPath of docs) {
    const text = readFromSecondbrain(docPath);
    assert.doesNotMatch(text, /\bchatgpt\b|ChatGPT|claude-app|Claude app/i, docPath);
  }
});

test('coding-tool determinism contract documents the OpenClaw-derived behavior', () => {
  const text = readFromSecondbrain('docs/contracts/CODING_TOOL_DETERMINISM.md');

  for (const label of ['OpenClaw', 'Codex', 'Claude Code', 'Hermes']) {
    assert.match(text, new RegExp(label), `contract should name ${label}`);
  }

  assert.match(text, /jarvos-capture/);
  assert.match(text, /`?CaptureEvent`? v2/);
  assert.match(text, /Journal\/YYYY-MM-DD\.md/);
  assert.match(text, /exactly once/);
  assert.match(text, /provenance/);
  assert.match(text, /knowledge sidecars/);
  assert.match(text, /QMD pending/);
  assert.match(text, /not automatically ingested/);
});

test('supported coding runtime docs point at the shared capture path', () => {
  const runtimeDocs = [
    ['runtimes/codex/README.md', 'codex'],
    ['runtimes/claude/templates/CLAUDE.md.template', 'claude-code'],
    ['runtimes/hermes/skills/jarvos/SKILL.md', 'hermes'],
    ['runtimes/openclaw/README.md', 'openclaw'],
  ];

  for (const [docPath, source] of runtimeDocs) {
    const text = readFromRepo(docPath);
    assert.match(text, new RegExp(`source[\\s\\S]{0,80}\\\`?${source}\\\`?`, 'i'), docPath);
    assert.match(text, /jarvos-capture|universal capture/i, docPath);
    assert.match(text, /Journal\/YYYY-MM-DD\.md/, docPath);
    assert.match(text, /exactly once/i, docPath);
    assert.match(text, /pending-refresh/, docPath);
    assert.match(text, /do not raw-write|raw-writing|do not create guessed|must not create guessed|must not raw-write/i, docPath);
  }
});
