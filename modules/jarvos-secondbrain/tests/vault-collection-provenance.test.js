'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const secondbrain = require('../src/index.js');

test('buildQmdVaultCollectionConfig indexes the full vault, not one folder at a time', () => {
  const config = secondbrain.buildQmdVaultCollectionConfig({
    vaultDir: '/tmp/example-vault',
  });

  assert.deepEqual(Object.keys(config.collections), ['vault']);
  assert.equal(config.collections.vault.path, '/tmp/example-vault');
  assert.equal(config.collections.vault.pattern, '**/*.md');
  assert.match(config.collections.vault.context[''], /Full vault content/);
  assert.match(config.collections.vault.context[''], /Source Material is external content/);
});

test('resolveSourceMaterialDir derives from the vault root', () => {
  process.env.JARVOS_VAULT_DIR = '/tmp/example-vault';
  try {
    assert.equal(
      secondbrain.resolveSourceMaterialDir(),
      path.join('/tmp/example-vault', 'Source Material'),
    );
  } finally {
    delete process.env.JARVOS_VAULT_DIR;
  }
});

test('validateSourceMaterialProvenance accepts explicit external source metadata', () => {
  const result = secondbrain.validateSourceMaterialProvenance({
    authorship: 'external',
    source_type: 'academic_paper',
    author: 'Gaya Herrington',
    source_pdf: 'Source Material/Papers/Herrington-Limits-2021.pdf',
    user_authored: false,
    ai_generated: false,
  });

  assert.equal(result.valid, true);
  assert.deepEqual(result.errors, []);
});

test('validateSourceMaterialProvenance rejects ambiguous ownership metadata', () => {
  const result = secondbrain.validateSourceMaterialProvenance({
    source_type: 'academic_paper',
    author: 'Gaya Herrington',
    user_authored: false,
  });

  assert.equal(result.valid, false);
  assert.match(result.errors.join('\n'), /authorship must be external/);
  assert.match(result.errors.join('\n'), /source_pdf, canonical_url, or source_url is required/);
  assert.match(result.errors.join('\n'), /ai_generated must be false/);
});
