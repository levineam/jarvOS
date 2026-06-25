#!/usr/bin/env node
'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const INVENTORY = path.join(ROOT, 'docs/architecture/secondbrain-external-integrations.md');

function read(filePath) {
  return fs.readFileSync(path.join(ROOT, filePath), 'utf8');
}

function inventoryRows(doc) {
  return doc
    .split('\n')
    .filter((line) => line.startsWith('| ') && !line.includes('---'))
    .map((line) => line.split('|').map((cell) => cell.trim()).filter(Boolean))
    .filter((cells) => cells.length >= 4 && cells[0] !== 'Component')
    .map((cells) => ({ component: cells[0], status: cells[1] }));
}

test('secondbrain external integration inventory names required components and statuses', () => {
  const doc = fs.readFileSync(INVENTORY, 'utf8');
  const rows = inventoryRows(doc);
  const required = [
    ['Obsidian-compatible Markdown vault', 'active'],
    ['Obsidian app', 'optional'],
    ['obsidian-cli', 'optional'],
    ['Defuddle', 'optional'],
    ['QMD', 'active'],
    ['GBrain', 'active'],
    ['OpenClaw memory-wiki', 'active'],
    ['OpenClaw runtime memory', 'active'],
    ['generated LLM-wiki / secondbrain wiki', 'generated'],
    ['Paperclip', 'active'],
    ['agentmemory', 'dogfood-optional'],
    ['Engraph', 'deferred'],
    ['Obsidian Linter', 'guarded'],
    ['Obsidian Bases and JSON Canvas', 'optional'],
  ];

  for (const [component, status] of required) {
    assert.ok(
      rows.some((row) => row.component === component && row.status === status),
      `${component} should be listed as ${status}`,
    );
  }
});

test('secondbrain external integration inventory preserves authority boundaries', () => {
  const doc = fs.readFileSync(INVENTORY, 'utf8');
  const normalized = doc.replace(/\s+/g, ' ').toLowerCase();
  const requiredClaims = [
    'jarvOS-owned modules are adapters, contracts, and guardrails',
    'canonical source of truth for authored notes and daily journals',
    'Freshness is explicit through `qmd-refresh-pending.json`',
    'Reviewed structured graph memory',
    'not public-core, not durable truth, not live task state',
    'must not auto-promote into GBrain, Vault notes, Paperclip, ontology, or durable memory',
    'Not production-integrated',
    'No automatic ingestion of every AI conversation',
  ];

  for (const claim of requiredClaims) {
    assert.ok(normalized.includes(claim.toLowerCase()), `missing boundary claim: ${claim}`);
  }
});

test('public docs link to the secondbrain external integration inventory', () => {
  const rootLink = 'docs/architecture/secondbrain-external-integrations.md';
  assert.ok(read('README.md').includes(rootLink), `README.md should link to ${rootLink}`);

  const packageLink = 'https://github.com/levineam/jarvOS/blob/main/docs/architecture/secondbrain-external-integrations.md';
  const packageReadmes = [
    'modules/jarvos-secondbrain/README.md',
    'modules/jarvos-gbrain/README.md',
    'modules/jarvos-skills/README.md',
  ];

  for (const filePath of packageReadmes) {
    const contents = read(filePath);
    assert.ok(contents.includes(packageLink), `${filePath} should link to ${packageLink}`);
    assert.ok(
      !contents.includes('../../docs/architecture/secondbrain-external-integrations.md'),
      `${filePath} should not use a monorepo-relative package README link`,
    );
  }
});

test('package allowlist includes the linked secondbrain integration inventory', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.ok(
    pkg.files.includes('docs/architecture/secondbrain-external-integrations.md'),
    'package files should include the README-linked integration inventory',
  );
});
