'use strict';

const assert = require('assert');
const test = require('node:test');

const {
  createProtectedResourceDefinition,
  createProtectedResourceRegistry,
  evaluateProtectedMutation,
  matchProtectedResourceIdentity,
} = require('../src/index.js');

function dailyJournalDefinition(overrides = {}) {
  return createProtectedResourceDefinition({
    resourceId: 'daily-journal',
    resourceType: 'daily-journal',
    owningAdapter: 'obsidian-note-journal-contract',
    allowedOperations: [
      'journal.create-from-template',
      'journal.append-note-backlink',
      'journal.section-aware-update',
    ],
    identityMatcher: {
      kind: 'daily-journal-file',
      parentName: 'Journal',
      basenamePattern: '^\\d{4}-\\d{2}-\\d{2}\\.md$',
    },
    sanctionedRoute: {
      summary: 'Use the resource-owned journal contract',
      message: 'Daily Journal is protected. Use node scripts/obsidian-note-journal-contract.js instead of raw Write/Edit.',
      commands: ['node scripts/obsidian-note-journal-contract.js'],
      operations: ['journal.append-note-backlink'],
    },
    ...overrides,
  });
}

test('protected resource definition rejects absolute personal paths being required', () => {
  const definition = dailyJournalDefinition();
  assert.equal(definition.resourceId, 'daily-journal');
  assert.equal(definition.owningAdapter, 'obsidian-note-journal-contract');
  assert.equal(definition.allowedOperations.length, 3);
  assert.ok(!JSON.stringify(definition).includes('/Users/'));
});

test('identity matcher recognizes daily journal basename/parent conventions', () => {
  const definition = dailyJournalDefinition();
  const hit = matchProtectedResourceIdentity(definition, {
    basename: '2026-07-17.md',
    parentName: 'Journal',
    segments: ['Vault', 'Journal', '2026-07-17.md'],
  });
  assert.equal(hit.matched, true);
  assert.equal(hit.identity.date, '2026-07-17');

  const miss = matchProtectedResourceIdentity(definition, {
    basename: 'notes.md',
    parentName: 'Journal',
    segments: ['Vault', 'Journal', 'notes.md'],
  });
  assert.equal(miss.matched, false);
});

test('raw filesystem write/edit against protected resource is denied with sanctioned route', () => {
  const resource = dailyJournalDefinition();
  for (const mutationKind of ['raw-filesystem-write', 'raw-filesystem-edit']) {
    const decision = evaluateProtectedMutation({
      resource,
      mutationKind,
      actor: { kind: 'agent', harness: 'claude-code' },
      target: { basename: '2026-07-17.md' },
    });
    assert.equal(decision.outcome, 'deny');
    assert.equal(decision.protectedTarget, true);
    assert.match(decision.message, /obsidian-note-journal-contract/);
    assert.equal(decision.owningAdapter, 'obsidian-note-journal-contract');
    assert.equal(decision.policyDecision.outcome, 'deny');
  }
});

test('named allowed operations are permitted through owning adapter', () => {
  const decision = evaluateProtectedMutation({
    resource: dailyJournalDefinition(),
    mutationKind: 'named-operation',
    operation: 'journal.append-note-backlink',
    actor: { kind: 'agent', harness: 'claude-code' },
  });
  assert.equal(decision.outcome, 'allow');
  assert.equal(decision.reasonCode, 'named-operation-allowed');
  assert.equal(decision.allowedOperation.operation, 'journal.append-note-backlink');
});

test('unknown named operation on protected resource is denied', () => {
  const decision = evaluateProtectedMutation({
    resource: dailyJournalDefinition(),
    mutationKind: 'named-operation',
    operation: 'journal.full-file-replace',
  });
  assert.equal(decision.outcome, 'deny');
  assert.equal(decision.reasonCode, 'unknown-operation');
});

test('unprotected targets remain allow and do not require policy', () => {
  const decision = evaluateProtectedMutation({
    resource: null,
    mutationKind: 'raw-filesystem-write',
    policyAvailable: false,
    target: { basename: 'readme.md' },
  });
  assert.equal(decision.outcome, 'allow');
  assert.equal(decision.reasonCode, 'unprotected-target');
  assert.equal(decision.protectedTarget, false);
});

test('policy unavailability fails closed for protected targets', () => {
  const decision = evaluateProtectedMutation({
    resource: dailyJournalDefinition(),
    mutationKind: 'raw-filesystem-write',
    policyAvailable: false,
  });
  assert.equal(decision.outcome, 'fail_closed');
  assert.equal(decision.reasonCode, 'policy-unavailable');
  assert.equal(decision.policyDecision.outcome, 'deny');
});

test('registry matches identity and evaluates without absolute paths', () => {
  const registry = createProtectedResourceRegistry([dailyJournalDefinition()]);
  const found = registry.matchIdentity({
    basename: '2026-07-17.md',
    parentName: 'Journal',
    segments: ['x', 'Journal', '2026-07-17.md'],
  });
  assert.ok(found);
  assert.equal(found.definition.resourceId, 'daily-journal');

  const denied = registry.evaluate({
    identity: {
      basename: '2026-07-17.md',
      parentName: 'Journal',
      segments: ['x', 'Journal', '2026-07-17.md'],
    },
    mutationKind: 'raw-filesystem-write',
  });
  assert.equal(denied.outcome, 'deny');

  const allowed = registry.evaluate({
    identity: {
      basename: 'other.md',
      parentName: 'Notes',
      segments: ['x', 'Notes', 'other.md'],
    },
    mutationKind: 'raw-filesystem-write',
  });
  assert.equal(allowed.outcome, 'allow');
});

test('malformed definitions fail closed at construction', () => {
  assert.throws(() => createProtectedResourceDefinition({
    resourceId: 'x',
    owningAdapter: 'y',
  }), /allowedOperations|mutationClasses/);
});
