'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const providers = require('../src/provider-selection');

const fixturePath = path.resolve(__dirname, '../fixtures/grok-cli-1.0.3-capability.json');

test('redacted Grok capability fixture binds the typed unsupported descriptor without private state', () => {
  const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
  assert.equal(fixture.schemaVersion, 'jarvos-grok-cli-capability-proof/v1');
  assert.equal(fixture.provider, providers.GROK_SUBSCRIPTION_ADAPTER_DESCRIPTOR.provider);
  assert.equal(fixture.model, providers.GROK_SUBSCRIPTION_ADAPTER_DESCRIPTOR.models[0]);
  assert.equal(fixture.support, 'unsupported');
  assert.equal(fixture.reasonCode, 'capability_unsupported');
  assert.equal(fixture.cli.version, providers.GROK_SUBSCRIPTION_ADAPTER_DESCRIPTOR.distribution.version);
  assert.equal(fixture.cli.executableDigest, providers.GROK_SUBSCRIPTION_ADAPTER_DESCRIPTOR.distribution.revision);
  assert.deepEqual(fixture.auth, {
    mode: 'oidc-subscription', issuerHost: 'auth.x.ai', isolatedCredentialRoot: true,
    ownerPrivate: true, apiKeyFallbackDenied: true,
  });
  assert.equal(fixture.invocation.promptTransport, 'owner-private-file');
  assert.equal(fixture.invocation.tools, 'advertised-despite-empty-allowlist');
  assert.equal(fixture.terminalProof.servedModel, 'grok-4.5-build');
  assert.equal(fixture.terminalProof.advertisedToolCount, 24);
  assert.equal(fixture.terminalProof.toolUseCount, 0);
  assert.equal(fixture.terminalProof.webSearchRequests, 0);
  assert.deepEqual(fixture.blockingCapabilities, [
    'terminal-tool-surface-not-empty',
    'provider-endpoint-network-boundary-unenforced',
  ]);
  const serialized = JSON.stringify(fixture);
  assert.doesNotMatch(serialized, /\/Users\/|\/home\/|token|email|principal|promptText|promptBody/i);
});
