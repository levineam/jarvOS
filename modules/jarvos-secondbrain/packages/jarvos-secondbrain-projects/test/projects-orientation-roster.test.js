'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { ProjectRegistry } = require('../src/registry');
const { buildContextPacket, validateContextPacket } = require('../src/projects-context');
const { issueCapability } = require('../src/projects-context-capability');
const { resolveQueryProfile } = require('../src/projects-context-profiles');
const { createHostAdmission } = require('../src/provider-contracts');

const NOW = '2026-09-29T12:00:00.000Z';
const SECRET = 'orientation-roster-test-secret';
const PROVIDER_SECRET = 'orientation-roster-provider-secret';
const LONG_GOAL = 'Grow the portfolio into a durable, self-funding practice with clear operating rhythms and owners. '.repeat(20);
const LONG_DONE = 'Every deliverable is shipped, reviewed, and measured against the agreed acceptance criteria. '.repeat(20);

// ~35 records: one verbose portfolio (5 records) plus nine other active
// top-level projects, a paused one, and outcomes spread across them.
function portfolioFixture(t) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'projects-orientation-roster-'));
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  const registry = new ProjectRegistry({ stateDir, now: () => NOW });
  const verbose = registry.create({ title: 'Amazing Abundance Portfolio', goal: LONG_GOAL, definitionOfDone: LONG_DONE }).record;
  for (let i = 1; i <= 4; i += 1) {
    registry.create({ kind: 'outcome', title: `Abundance outcome ${i}`, parentId: verbose.id, goal: LONG_GOAL, definitionOfDone: LONG_DONE });
  }
  const names = ['jarvOS', 'Proof of Value', 'Swarm Theory Book', 'Field Notes', 'Garden', 'Home Lab', 'Taxes', 'Studio', 'Reading List'];
  const projects = names.map((title) => registry.create({ title, goal: `Goal for ${title}. ${LONG_GOAL}`, definitionOfDone: LONG_DONE }).record);
  const outcomes = [];
  for (const project of projects) {
    for (let i = 1; i <= 3; i += 1) {
      outcomes.push(registry.create({ kind: 'outcome', title: `${project.title} outcome ${i}`, parentId: project.id, goal: LONG_GOAL }).record);
    }
  }
  const paused = registry.create({ title: 'Paused Idea', lifecycle: 'paused' }).record;
  assert.ok(registry.list().length >= 35, `fixture has ${registry.list().length} records`);
  return { registry, verbose, projects, outcomes, paused };
}

function orientationInput(registry, providers = {}) {
  const profile = resolveQueryProfile('orientation', { authorizedScope: true });
  const capability = issueCapability({
    authorization: { allowed: true }, hostId: 'roster-host', hostSecret: SECRET,
    subject: 'agent:orientation', query: profile.query, scope: profile.query.scope, limits: profile.query.limits,
    redactionClass: 'private', providerCoverage: ['activity', 'todo', 'beads', 'paperclip', 'release', 'stewardship'],
    capabilityRevision: 'orientation-roster-1', issuedAt: NOW, expiresAt: '2026-09-29T13:00:00.000Z', nonce: 'orientation-roster',
  });
  return {
    registry, query: profile.query, capability, capabilitySecret: SECRET, subject: 'agent:orientation', hostId: 'roster-host', now: NOW,
    providers,
    providerAuthorities: Object.fromEntries(Object.keys(providers).map((name) => [
      name, createHostAdmission({ producerId: `provider:${name}`, secret: PROVIDER_SECRET, allowedProviders: [name] }),
    ])),
  };
}

function todoSnapshot(canonicalId, attentionCount = 0) {
  const base = {
    contract: 'jarvos.provider-snapshot/v1', provider: 'todo', state: 'fresh', trust: 'verified', capturedAt: NOW,
    watermark: 'todo-1', scope: { projectIds: [], outcomeIds: [] }, omissions: [], errorCode: null, admission: null,
    summaries: [{
      id: 'todo-active', canonicalId, category: 'intent', status: 'open', title: 'Active work',
      occurredAt: NOW, observedAt: NOW, evidenceRefs: ['todo:active'],
    }, ...Array.from({ length: attentionCount }, (_, index) => ({
      id: `todo-blocked-${index}`, canonicalId, category: 'attention', status: 'blocked', title: `Blocked work ${index}`,
      occurredAt: NOW, observedAt: NOW, evidenceRefs: [`todo:blocked-${index}`],
    }))],
  };
  return createHostAdmission({ producerId: 'provider:todo', secret: PROVIDER_SECRET, allowedProviders: ['todo'] }).admitProviderSnapshot(base);
}

test('orientation packet keeps every active top-level project even when one portfolio is verbose', (t) => {
  const { registry, verbose, projects, paused } = portfolioFixture(t);
  const result = buildContextPacket(orientationInput(registry));
  assert.equal(result.status, 'ok');
  const { packet } = result;
  assert.equal(validateContextPacket(packet).ok, true);
  assert.ok(Buffer.byteLength(JSON.stringify(packet)) <= 16000, 'byte cap holds');
  const ids = new Set(packet.canonical.records.map((record) => record.id));
  for (const project of [verbose, ...projects]) assert.ok(ids.has(project.id), `${project.title} is in the packet`);
  assert.ok(packet.canonical.records.length <= 24, 'item cap holds');
  // Long detail is compacted to a one-line goal instead of crowding out projects.
  for (const record of packet.canonical.records) assert.ok(record.goal === null || record.goal.length <= 100);
  assert.ok(packet.canonical.records.some((record) => record.goal && record.goal.length > 40));
  assert.ok(packet.omissions.includes('canonical:record-detail-compacted'));
  // The survivors are spread across projects rather than clustered under the first one.
  const withOutcome = new Set(packet.canonical.records.filter((record) => record.kind === 'outcome').map((record) => record.parentId));
  for (const project of [verbose, ...projects]) assert.ok(withOutcome.has(project.id), `${project.title} keeps an outcome`);
  // A paused project is not part of the guaranteed roster and may be dropped.
  assert.equal(packet.canonical.records.some((record) => record.id === paused.id), false);
});

test('roster survives a tight byte budget: goals and detail go before roster lines', (t) => {
  const { registry, verbose, projects } = portfolioFixture(t);
  const input = orientationInput(registry);
  const bytes = 9000;
  const query = { ...input.query, limits: { ...input.query.limits, maxBytes: bytes } };
  const capability = issueCapability({
    authorization: { allowed: true }, hostId: 'roster-host', hostSecret: SECRET,
    subject: 'agent:orientation', query, scope: query.scope, limits: query.limits,
    redactionClass: 'private', providerCoverage: ['activity', 'todo', 'beads', 'paperclip', 'release', 'stewardship'],
    capabilityRevision: 'orientation-roster-1', issuedAt: NOW, expiresAt: '2026-09-29T13:00:00.000Z', nonce: 'orientation-roster',
  });
  const result = buildContextPacket({ ...input, query, capability });
  assert.equal(result.status, 'ok');
  assert.equal(validateContextPacket(result.packet).ok, true);
  assert.ok(Buffer.byteLength(JSON.stringify(result.packet)) <= bytes);
  const roster = new Set(result.packet.canonical.records.filter((record) => record.parentId === null).map((record) => record.id));
  for (const project of [verbose, ...projects]) assert.ok(roster.has(project.id), `${project.title} kept`);
  // Non-roster records were the ones dropped, and the truncation is reported.
  assert.equal(result.packet.truncation.truncated, true);
  assert.ok(result.packet.truncation.sections.includes('canonical.records'));
});

test('records with current activity keep detail and are dropped last', (t) => {
  const { registry, outcomes } = portfolioFixture(t);
  const active = outcomes[outcomes.length - 1];
  const providers = { todo: todoSnapshot(active.id) };
  const result = buildContextPacket(orientationInput(registry, providers));
  assert.equal(result.status, 'ok');
  const kept = result.packet.canonical.records.map((record) => record.id);
  assert.ok(kept.includes(active.id), 'the outcome with current work survives the trim');
  assert.ok(kept.includes(active.parentId), 'its parent project stays so the hierarchy is valid');
  assert.equal(validateContextPacket(result.packet).ok, true);
});

test('attention rows are trimmed before active projects at the item cap', (t) => {
  const { registry, verbose, projects } = portfolioFixture(t);
  const moreProjects = Array.from({ length: 11 }, (_, index) => registry.create({ title: `Extra project ${index}` }).record);
  const roster = [verbose, ...projects, ...moreProjects];
  const result = buildContextPacket(orientationInput(registry, { todo: todoSnapshot(verbose.id, 4) }));
  assert.equal(result.status, 'ok');
  const kept = new Set(result.packet.canonical.records.map((record) => record.id));
  for (const project of roster) assert.ok(kept.has(project.id), `${project.title} survives the item cap`);
  assert.ok(result.packet.attention.length < 4, 'attention yields capacity to the roster');
  assert.equal(validateContextPacket(result.packet).ok, true);
});
