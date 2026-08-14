'use strict';

const assert = require('assert');
const test = require('node:test');
const {
  issueRouteCapability,
  validateRouteCapability,
} = require('../src');

const route = {
  harness: 'hermes',
  profile: 'default',
  platform: 'telegram',
  conversation: 'chat-1',
  sender: 'user-1',
  nativeSession: 'native-1',
  generation: 'hermes-jarvos.v1',
};

test('route capability is opaque, short-lived, generation-bound, and collision-safe', () => {
  const token = issueRouteCapability({ route, secret: 'test-secret-that-is-long-enough', now: 100_000, ttlMs: 5_000 });
  assert.equal(token.includes('telegram'), false);
  assert.equal(token.includes('chat-1'), false);
  assert.deepEqual(validateRouteCapability(token, { secret: 'test-secret-that-is-long-enough', expectedGeneration: route.generation, now: 100_001 }), {
    ok: true,
    routeDigest: validateRouteCapability(token, { secret: 'test-secret-that-is-long-enough', expectedGeneration: route.generation, now: 100_001 }).routeDigest,
    generation: route.generation,
    issuedAt: 100_000,
    expiresAt: 105_000,
  });
  assert.equal(validateRouteCapability(token, { secret: 'test-secret-that-is-long-enough', expectedGeneration: 'other.v1', now: 100_001 }).code, 'route_capability_generation_mismatch');
  assert.equal(validateRouteCapability(token, { secret: 'test-secret-that-is-long-enough', expectedGeneration: route.generation, now: 105_000 }).code, 'route_capability_expired');
  assert.equal(validateRouteCapability(token, { secret: 'wrong-secret-that-is-long-enough', expectedGeneration: route.generation, now: 100_001 }).code, 'route_capability_invalid');
});

test('different normalized route dimensions produce different opaque bindings', () => {
  const first = issueRouteCapability({ route, secret: 'test-secret-that-is-long-enough', now: 100_000 });
  const second = issueRouteCapability({ route: { ...route, nativeSession: 'native-2' }, secret: 'test-secret-that-is-long-enough', now: 100_000 });
  const one = validateRouteCapability(first, { secret: 'test-secret-that-is-long-enough', expectedGeneration: route.generation, now: 100_001 });
  const two = validateRouteCapability(second, { secret: 'test-secret-that-is-long-enough', expectedGeneration: route.generation, now: 100_001 });
  assert.notEqual(one.routeDigest, two.routeDigest);
});
