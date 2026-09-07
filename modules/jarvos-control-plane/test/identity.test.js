'use strict';

const assert = require('node:assert');
const test = require('node:test');

const {
  IDENTITY_SCHEMA_VERSION,
  IDENTITY_KINDS,
  parseIdentity,
  validateIdentity,
  assertIdentity,
} = require('../src/index.js');

test('exposes a stable schema version and frozen kind list', () => {
  assert.strictEqual(IDENTITY_SCHEMA_VERSION, 'jarvos.identity.v1');
  assert.ok(Object.isFrozen(IDENTITY_KINDS));
  assert.deepStrictEqual(IDENTITY_KINDS, [
    'mind', 'installation', 'host', 'harness-instance', 'session',
    'source-event', 'candidate', 'artifact', 'project', 'policy', 'receipt',
  ]);
});

test('every allowed kind validates, parses, and asserts', () => {
  for (const kind of IDENTITY_KINDS) {
    const value = `jarvos:${kind}:acme.tools:a0-9_.z`;
    assert.deepStrictEqual(validateIdentity(value), []);
    assert.deepStrictEqual(validateIdentity(value, kind), []);
    assert.deepStrictEqual(parseIdentity(value), {
      scheme: 'jarvos', kind, namespace: 'acme.tools', opaque: 'a0-9_.z',
    });
    assert.strictEqual(assertIdentity(value, kind), value);
  }
});

test('an expected kind must match exactly', () => {
  const value = 'jarvos:project:acme:one';
  assert.deepStrictEqual(validateIdentity(value, 'project'), []);
  assert.ok(validateIdentity(value, 'candidate').length > 0);
  assert.strictEqual(parseIdentity(value, 'candidate'), null);
  assert.throws(() => assertIdentity(value, 'candidate'), /identity/);
});

test('an unknown expected kind is rejected', () => {
  assert.ok(validateIdentity('jarvos:project:acme:one', 'nonsense').length > 0);
});

test('malformed identities fail closed', () => {
  const invalid = [
    'JARVOS:project:acme:one',
    'jarvos:project:ACME:one',
    'jarvos:unknown:acme:one',
    'jarvos:project:acme',
    'jarvos:project:acme:one:two',
    'jarvos:project:acme:pa/th',
    'jarvos:project:acme:pa\\th',
    'jarvos:project:acme:pct%20',
    'jarvos:project:ac me:one',
    'jarvos:project::one',
    'jarvos:project:acme:',
    `jarvos:project:acme:${'x'.repeat(300)}`,
    'jarvos:project:-acme:one',
    '',
  ];
  for (const value of invalid) {
    assert.ok(validateIdentity(value).length > 0, `expected rejection: ${value}`);
    assert.strictEqual(parseIdentity(value), null);
    assert.throws(() => assertIdentity(value));
  }
});

test('non-string input is rejected without throwing during validation', () => {
  for (const value of [null, undefined, 42, {}, []]) {
    assert.ok(validateIdentity(value).length > 0);
    assert.strictEqual(parseIdentity(value), null);
  }
});

test('validation never mutates or normalizes the input value', () => {
  const value = 'jarvos:session:acme:keep-as-is';
  assert.deepStrictEqual(validateIdentity(value), []);
  assert.strictEqual(value, 'jarvos:session:acme:keep-as-is');
});
