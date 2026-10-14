'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const test = require('node:test');

const {
  CAPABILITY_DESCRIPTOR_VERSION,
  CAPABILITY_VOCABULARY,
  resolveCapabilityDescriptor,
  validateCapabilityDescriptor,
} = require('../src/index.js');

const ROOT = path.resolve(__dirname, '..', '..', '..');

function descriptor(harness = 'sample') {
  const capabilities = {};
  for (const [group, names] of Object.entries(CAPABILITY_VOCABULARY)) {
    capabilities[group] = Object.fromEntries(names.map((name) => [name, {
      status: 'supported', transport: 'public-test', evidence: 'Public test declaration.',
    }]));
  }
  return {
    version: CAPABILITY_DESCRIPTOR_VERSION,
    harness,
    capabilities,
    probe: { version: '1.0.0', packageDigest: 'a'.repeat(64), attestedAt: '2026-08-10T00:00:00.000Z' },
  };
}

test('validates full public capability descriptors and resolves public, installed, and probe evidence conservatively', () => {
  const publicDescriptor = descriptor();
  assert.deepEqual(validateCapabilityDescriptor(publicDescriptor), { ok: true, errors: [] });

  const resolved = resolveCapabilityDescriptor({
    descriptor: publicDescriptor,
    installedOverlay: {
      version: CAPABILITY_DESCRIPTOR_VERSION,
      harness: 'sample',
      capabilities: { context: { startupHydration: { status: 'supported', transport: 'installed-test', evidence: 'Installed test declaration.' } } },
      probe: { version: '1.0.0', packageDigest: 'a'.repeat(64), attestedAt: '2026-08-10T00:00:00.000Z' },
    },
    currentProbe: { version: '1.0.0', packageDigest: 'a'.repeat(64), attestedAt: '2026-08-10T00:00:00.000Z' },
  });
  assert.equal(resolved.ok, true, resolved.errors?.join('\n'));
  assert.equal(resolved.capabilities.context.startupHydration.status, 'supported');

  const noPromotion = resolveCapabilityDescriptor({
    descriptor: {
      ...publicDescriptor,
      capabilities: { ...publicDescriptor.capabilities, context: { ...publicDescriptor.capabilities.context, startupHydration: { status: 'manual', transport: 'manual-command', reason: 'No verified hook.' } } },
    },
    installedOverlay: {
      version: CAPABILITY_DESCRIPTOR_VERSION,
      harness: 'sample',
      capabilities: { context: { startupHydration: { status: 'supported', transport: 'private-hook', evidence: 'Private test declaration.' } } },
    },
  });
  assert.equal(noPromotion.capabilities.context.startupHydration.status, 'manual');
  assert.match(noPromotion.capabilities.context.startupHydration.reason, /No verified hook/);

  const noUnsupportedPromotion = resolveCapabilityDescriptor({
    descriptor: {
      ...publicDescriptor,
      capabilities: { ...publicDescriptor.capabilities, session: { ...publicDescriptor.capabilities.session, handoff: { status: 'unsupported', reason: 'No public handoff.' } } },
    },
    installedOverlay: {
      version: CAPABILITY_DESCRIPTOR_VERSION,
      harness: 'sample',
      capabilities: { session: { handoff: { status: 'supported', transport: 'private-handoff', evidence: 'Private test declaration.' } } },
    },
  });
  assert.equal(noUnsupportedPromotion.capabilities.session.handoff.status, 'unsupported');
  assert.match(noUnsupportedPromotion.capabilities.session.handoff.reason, /No public handoff/);

  const stale = resolveCapabilityDescriptor({
    descriptor: publicDescriptor,
    currentProbe: { version: '2.0.0', packageDigest: 'b'.repeat(64), attestedAt: '2026-08-10T00:00:00.000Z' },
  });
  assert.equal(stale.capabilities.context.currentWork.status, 'unsupported');
  assert.match(stale.capabilities.context.currentWork.reason, /probe/i);

  const expired = resolveCapabilityDescriptor({
    descriptor: publicDescriptor,
    currentProbe: { version: '1.0.0', packageDigest: 'a'.repeat(64), attestedAt: '2026-08-01T00:00:00.000Z' },
    maxProbeAgeMs: 60_000,
    now: Date.parse('2026-08-10T00:00:00.000Z'),
  });
  assert.equal(expired.capabilities.context.currentWork.status, 'unsupported');
  assert.match(expired.capabilities.context.currentWork.reason, /stale/i);
});

test('unknown or absent capabilities resolve unsupported and generic descriptors reject provider fields', () => {
  const sparse = {
    version: CAPABILITY_DESCRIPTOR_VERSION,
    harness: 'sample',
    capabilities: { context: { currentWork: { status: 'supported', transport: 'mcp', evidence: 'Public test declaration.' } } },
  };
  const resolved = resolveCapabilityDescriptor({ descriptor: sparse });
  assert.equal(resolved.ok, true);
  assert.equal(resolved.capabilities.skills.invoke.status, 'unsupported');
  assert.equal(resolved.capabilities.context.notARealCapability, undefined);

  const invalid = validateCapabilityDescriptor({ ...sparse, provider: 'private-provider' });
  assert.equal(invalid.ok, false);
  assert.match(invalid.errors.join('\n'), /unknown field: provider/);

  const unsupportedClaim = validateCapabilityDescriptor({
    ...sparse,
    capabilities: { context: { currentWork: { status: 'supported', transport: 'mcp' } } },
  });
  assert.equal(unsupportedClaim.ok, false);
  assert.match(unsupportedClaim.errors.join('\n'), /evidence is required/);
});

test('all checked-in runtime descriptors enumerate the portable capability matrix and preserve existing fixtures', () => {
  for (const runtime of ['hermes', 'codex', 'claude', 'openclaw']) {
    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'runtimes', runtime, 'adapter.json'), 'utf8'));
    const result = validateCapabilityDescriptor(manifest.capabilityDescriptor);
    assert.equal(result.ok, true, `${runtime}: ${result.errors.join('\n')}`);
    for (const [group, names] of Object.entries(CAPABILITY_VOCABULARY)) {
      assert.ok(manifest.capabilityDescriptor.capabilities[group], `${runtime}: missing ${group}`);
      for (const name of names) assert.ok(manifest.capabilityDescriptor.capabilities[group][name], `${runtime}: missing ${group}.${name}`);
    }
    assert.match(
      JSON.stringify(manifest.capabilityDescriptor),
      /"reason"/,
      `${runtime}: manual or unsupported descriptor entries need public reasons`,
    );
  }
});
