'use strict';
// Configuration behavior tests for the bundled Desktop companion.

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const { loadConfig } = require('../server/config');
const health = require('../server/adapters/health');
const paperclip = require('../server/adapters/paperclip');

test('defaults are portable and PORT overrides the resolved port', () => {
  const cfg = loadConfig({ env: { PORT: '4999' } });
  assert.equal(cfg.port, 4999);
  assert.equal(cfg.vault.journalDir, null);
  assert.equal(cfg.paperclip.url, null);
  assert.equal(cfg.appRoot, path.join(__dirname, '..'));
});

test('explicit configuration deep-merges defaults and expands tilde paths', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-desktop-config-'));
  const config = path.join(dir, 'config.json');
  fs.writeFileSync(config, JSON.stringify({ vault: { notesDir: '~/Notes' }, paperclip: { url: 'http://localhost:3000' } }));
  const cfg = loadConfig({ env: { JARVOS_DESKTOP_CONFIG: config } });
  assert.equal(cfg.vault.notesDir, path.join(os.homedir(), 'Notes'));
  assert.equal(cfg.vault.journalDir, null);
  assert.equal(cfg.paperclip.url, 'http://localhost:3000');
  assert.equal(cfg.paperclip.companyId, null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('invalid explicit configuration rejects clearly', () => {
  assert.throws(() => loadConfig({ env: { JARVOS_DESKTOP_CONFIG: '/missing/config.json' } }), /JARVOS_DESKTOP_CONFIG is missing or malformed/);
});

test('explicit configuration must be a non-empty JSON object', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-desktop-config-'));
  const write = (name, content) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, content);
    return file;
  };
  assert.throws(() => loadConfig({ env: { JARVOS_DESKTOP_CONFIG: '' } }), /must name a configuration file/);
  assert.throws(() => loadConfig({ env: { JARVOS_DESKTOP_CONFIG: write('malformed.json', '{') } }), /JARVOS_DESKTOP_CONFIG is missing or malformed/);
  for (const [name, content] of [['scalar.json', '1'], ['null.json', 'null'], ['array.json', '[]']]) {
    assert.throws(() => loadConfig({ env: { JARVOS_DESKTOP_CONFIG: write(name, content) } }), /must contain a JSON object/);
  }
  assert.throws(() => loadConfig({ env: { JARVOS_DESKTOP_CONFIG: write('prototype.json', '{"__proto__":{}}') } }), /forbidden key/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('invalid nested configuration and ports reject before use', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-desktop-config-'));
  const config = path.join(dir, 'config.json');
  for (const [key, value] of [['vault', null], ['memory', null], ['paperclip', []], ['projectsContext', null], ['whisper', null], ['systemDoctor', null]]) {
    fs.writeFileSync(config, JSON.stringify({ [key]: value }));
    assert.throws(() => loadConfig({ env: { JARVOS_DESKTOP_CONFIG: config } }), new RegExp(`configuration\\.${key} must be an object`));
  }
  for (const port of ['', 'nope', '0', '65536']) {
    assert.throws(() => loadConfig({ env: { PORT: port } }), /port must be a TCP port/);
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test('unconfigured defaults report unavailable integrations without Paperclip access', async () => {
  const cfg = loadConfig({ env: {} });
  assert.equal(paperclip.configured(cfg.paperclip), false);
  const services = await health.services(cfg, '2026-01-01');
  assert.equal(services.find((service) => service.key === 'paperclip').ok, false);
  assert.equal(services.find((service) => service.key === 'journal').detail, 'not configured');
  assert.equal(services.find((service) => service.key === 'notes').detail, 'not configured');
});
