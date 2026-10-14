'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const {
  mergeContentOriginDrafting,
  normalizeDraftingList,
} = require('../bridge/provenance/src/content-origin-contract');
const { projectNoteMarkdown } = require('../bridge/provenance/src/content-origin-evidence');
const {
  canonicalizeFrontmatter,
  renderFrontmatter,
} = require('../packages/jarvos-secondbrain-notes/src/lib/note-schema');

const TODAY = '2026-10-08';
const BODY = 'Ship the drafting provenance contract.';

function digest(value) {
  return crypto.createHash('sha256').update(String(value).trim().replace(/\r\n/g, '\n')).digest('hex');
}

function receipt(text = BODY, id = 'capture-1') {
  return { capture_event_id: id, actor: 'user', source_digest: digest(text), content_digest: digest(text) };
}

function resolveUserSource(text = BODY, id = 'capture-1') {
  return (eventId) => (eventId === id ? { capture_event_id: id, actor: 'user', text } : null);
}

const codexDraft = { kind: 'assistant_draft', harness: 'codex', model: 'gpt-5-codex', model_evidence: 'declared' };
const claudeEdit = { kind: 'assistant_edit', harness: 'claude-code', model: 'claude-opus-5-5', model_evidence: 'declared' };

function canonical({ incoming = {}, existing = {}, origin = {} } = {}) {
  return canonicalizeFrontmatter({ incomingFrontmatter: incoming, existingFrontmatter: existing, today: TODAY, origin: { content: BODY, ...origin } });
}

test('valid verbatim receipt stays human with no assistant contribution from saving', () => {
  const result = canonical({
    incoming: { content_origin: 'human', content_origin_basis: 'verbatim_user', content_origin_source: receipt() },
    origin: { resolveUserSource: resolveUserSource() },
  });
  assert.deepEqual(result.errors, []);
  assert.equal(result.frontmatter.content_origin, 'human');
  assert.equal(result.frontmatter.human_evidence_eligible, true);
  assert.equal(result.frontmatter.content_origin_drafting, undefined);
});

test('Codex assistant draft records declared model', () => {
  const result = canonical({
    incoming: { content_origin: 'assistant', content_origin_basis: 'assistant_generated' },
    origin: { drafting: [codexDraft] },
  });
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.frontmatter.content_origin_drafting, [codexDraft]);
});

test('Claude mixed edit retains prior Codex draft and prior human receipt as history', () => {
  const existing = canonical({
    incoming: { content_origin: 'human', content_origin_basis: 'verbatim_user', content_origin_source: receipt() },
    origin: { resolveUserSource: resolveUserSource() },
  }).frontmatter;
  existing.content_origin_drafting = [codexDraft];
  const result = canonical({
    existing,
    incoming: { content_origin: 'mixed', content_origin_basis: 'mixed_composition', content_origin_drafting: [claudeEdit] },
  });
  assert.deepEqual(result.errors, []);
  assert.equal(result.frontmatter.human_evidence_eligible, false);
  assert.deepEqual(result.frontmatter.content_origin_drafting.map((entry) => entry.kind), ['assistant_draft', 'assistant_edit', 'user_source']);
  assert.equal(result.frontmatter.content_origin_source, undefined);
});

test('missing model is explicit unknown; missing history on assistant origin is explicitly unknown', () => {
  const declared = canonical({
    incoming: { content_origin: 'assistant', content_origin_basis: 'assistant_generated' },
    origin: { drafting: [{ kind: 'assistant_draft', harness: 'codex' }] },
  });
  assert.deepEqual(declared.frontmatter.content_origin_drafting, [{ kind: 'assistant_draft', harness: 'codex', model: 'unknown', model_evidence: 'unknown' }]);
  const bare = canonical({ incoming: { content_origin: 'mixed', content_origin_basis: 'mixed_composition' } });
  assert.deepEqual(bare.frontmatter.content_origin_drafting, [{ kind: 'assistant_edit', harness: 'unknown', model: 'unknown', model_evidence: 'unknown' }]);
});

test('served model requires the injected resolver and must match', () => {
  const served = { kind: 'assistant_draft', harness: 'codex', model: 'gpt-5-codex', model_evidence: 'served', served_ref: 'resp-1' };
  const resolveServedModel = (ref) => (ref === 'resp-1' ? { model: 'gpt-5-codex' } : null);
  assert.equal(mergeContentOriginDrafting({ incoming: [served], origin: 'assistant' }).reason, 'invalid_drafting:served_unresolved');
  assert.equal(mergeContentOriginDrafting({ incoming: [served], origin: 'assistant' }, { resolveServedModel }).ok, true);
  assert.equal(
    mergeContentOriginDrafting({ incoming: [{ ...served, model: 'other' }], origin: 'assistant' }, { resolveServedModel }).reason,
    'invalid_drafting:served_model_conflict',
  );
  // Persisted served entries are retained unchanged without re-resolution.
  assert.deepEqual(mergeContentOriginDrafting({ existing: [served], origin: 'assistant' }).entries, [served]);
});

test('invalid or conflicting history fails closed', () => {
  for (const bad of ['not-json', [{ kind: 'ghost' }], [{ kind: 'assistant_draft' }], [{ ...codexDraft, model_evidence: 'unknown' }]]) {
    const result = canonical({ existing: { content_origin_drafting: bad } });
    assert.ok(result.errors.some((error) => error.includes('content_origin_drafting')), JSON.stringify(bad));
  }
  assert.equal(normalizeDraftingList({}).ok, false);
});

test('pre-feature assistant/mixed notes are seeded with an unknown contributor that human adoption cannot erase', () => {
  for (const [origin, basis, kind] of [['assistant', 'assistant_generated', 'assistant_draft'], ['mixed', 'mixed_composition', 'assistant_edit']]) {
    const existing = { content_origin: origin, content_origin_basis: basis };
    const adopted = canonical({
      existing,
      incoming: { content_origin: 'human', content_origin_basis: 'verbatim_user', content_origin_source: receipt() },
      origin: { resolveUserSource: resolveUserSource() },
    });
    assert.ok(adopted.errors.some((error) => error.includes('human_origin_with_assistant_history')), origin);
    const carried = canonical({ existing });
    assert.deepEqual(carried.errors, []);
    assert.deepEqual(carried.frontmatter.content_origin_drafting, [{ kind, harness: 'unknown', model: 'unknown', model_evidence: 'unknown' }]);
  }
  // Historical unknown notes stay unknown with no fabricated history.
  const legacy = canonical({ existing: { content_origin: 'unknown', content_origin_basis: 'unknown' } });
  assert.equal(legacy.frontmatter.content_origin_drafting, undefined);
});

test('writer body change on a pre-feature assistant note keeps the seeded contributor', () => {
  const { createNoteMutationOperation } = require('../packages/jarvos-secondbrain-notes/src/write-to-vault');
  const { frontmatterToObject, parseFrontmatter } = require('../packages/jarvos-secondbrain-notes/src/lib/note-schema');
  const existingFrontmatter = { status: 'draft', type: 'reference', project: 'x', created: TODAY, updated: TODAY, author: 'jarvis', jarvos_note_id: 'n1', content_origin_schema: 'jarvos-content-origin/v1', content_origin: 'assistant', content_origin_basis: 'assistant_generated', human_evidence_eligible: false };
  const existingContent = `${renderFrontmatter(existingFrontmatter)}# Legacy\n\nOld assistant prose.\n`;
  const op = createNoteMutationOperation({
    vaultId: 'v', vaultRelativePath: 'Notes/Legacy.md', title: 'Legacy', operationId: 'legacy-1',
    content: 'New prose without a declaration.', existingContent, existingFrontmatter,
  });
  assert.equal(op.operationKind, 'replace');
  assert.ok(op.content.includes('Old assistant prose.'));
  const next = frontmatterToObject(parseFrontmatter(op.content));
  assert.equal(next.content_origin, 'unknown');
  assert.deepEqual(next.content_origin_drafting, [{ kind: 'assistant_draft', harness: 'unknown', model: 'unknown', model_evidence: 'unknown' }]);
});

test('assisted writer update with no origin declaration keeps the original human receipt as history only', () => {
  const { createNoteMutationOperation } = require('../packages/jarvos-secondbrain-notes/src/write-to-vault');
  const { frontmatterToObject, parseFrontmatter } = require('../packages/jarvos-secondbrain-notes/src/lib/note-schema');
  const base = { vaultId: 'v', vaultRelativePath: 'Notes/Receipt.md', title: 'Receipt' };
  const created = createNoteMutationOperation({
    ...base,
    operationId: 'receipt-1',
    content: BODY,
    frontmatter: { status: 'draft', content_origin: 'human', content_origin_basis: 'verbatim_user', content_origin_source: receipt() },
    resolveUserSource: resolveUserSource(),
  });
  const stored = frontmatterToObject(parseFrontmatter(created.content));
  assert.equal(stored.human_evidence_eligible, true);

  const contributor = { kind: 'assistant_edit', harness: 'codex' };
  const updated = createNoteMutationOperation({
    ...base,
    operationId: 'receipt-2',
    content: 'Codex added follow-up prose.',
    drafting: [contributor],
    existingContent: created.content,
    existingFrontmatter: stored,
  });
  assert.equal(updated.operationKind, 'replace');
  assert.ok(updated.content.includes(BODY));
  assert.ok(updated.content.includes('Codex added follow-up prose.'));
  const next = frontmatterToObject(parseFrontmatter(updated.content));
  assert.equal(next.content_origin, 'unknown');
  assert.equal(next.human_evidence_eligible, false);
  assert.equal(next.content_origin_source, undefined);
  assert.deepEqual(next.content_origin_drafting, [
    { kind: 'user_source', ...receipt() },
    { kind: 'assistant_edit', harness: 'codex', model: 'unknown', model_evidence: 'unknown' },
  ]);
  assert.equal(next.content_origin_drafting[0].source_digest, digest(BODY));
});

test('retry dedupes and appends history in order', () => {
  const first = mergeContentOriginDrafting({ incoming: [codexDraft], origin: 'assistant' });
  const retry = mergeContentOriginDrafting({ existing: first.entries, incoming: [codexDraft, claudeEdit], origin: 'mixed' });
  assert.deepEqual(retry.entries, [codexDraft, claudeEdit]);
});

test('human adoption, empty array, or omission cannot erase assistant history', () => {
  const existing = { content_origin: 'assistant', content_origin_basis: 'assistant_generated', content_origin_drafting: [codexDraft] };
  const adopted = canonical({
    existing,
    incoming: { content_origin: 'human', content_origin_basis: 'verbatim_user', content_origin_source: receipt(), content_origin_drafting: [] },
    origin: { resolveUserSource: resolveUserSource() },
  });
  assert.ok(adopted.errors.some((error) => error.includes('human_origin_with_assistant_history')));
  const omitted = canonical({ existing: { content_origin_drafting: [codexDraft] } });
  assert.deepEqual(omitted.errors, []);
  assert.equal(omitted.frontmatter.content_origin, 'unknown');
  assert.deepEqual(omitted.frontmatter.content_origin_drafting, [codexDraft]);
});

test('canonical writer operation persists history and a later Claude edit appends without erasing', () => {
  const { createNoteMutationOperation } = require('../packages/jarvos-secondbrain-notes/src/write-to-vault');
  const { frontmatterToObject, parseFrontmatter } = require('../packages/jarvos-secondbrain-notes/src/lib/note-schema');
  const base = { vaultId: 'vault-a', vaultRelativePath: 'Notes/Drafted.md', title: 'Drafted' };
  const created = createNoteMutationOperation({
    ...base,
    operationId: 'drafting-0001',
    content: BODY,
    frontmatter: { status: 'draft', content_origin: 'assistant', content_origin_basis: 'assistant_generated' },
    drafting: [codexDraft],
  });
  const stored = frontmatterToObject(parseFrontmatter(created.content));
  assert.deepEqual(stored.content_origin_drafting, [codexDraft]);

  const edited = createNoteMutationOperation({
    ...base,
    operationId: 'drafting-0002',
    content: `${BODY}\n\nClaude revision.`,
    frontmatter: { content_origin: 'mixed', content_origin_basis: 'mixed_composition', content_origin_drafting: [] },
    drafting: [claudeEdit],
    existingContent: created.content,
    existingFrontmatter: stored,
  });
  assert.equal(edited.operationKind, 'replace');
  const next = frontmatterToObject(parseFrontmatter(edited.content));
  assert.deepEqual(next.content_origin_drafting, [codexDraft, claudeEdit]);

  // Body change with no declaration keeps history but is unknown.
  const omitted = createNoteMutationOperation({
    ...base,
    operationId: 'drafting-0003',
    content: 'Unrelated new prose.',
    existingContent: edited.content,
    existingFrontmatter: next,
  });
  const after = frontmatterToObject(parseFrontmatter(omitted.content));
  assert.equal(after.content_origin, 'unknown');
  assert.deepEqual(after.content_origin_drafting, [codexDraft, claudeEdit]);
});

test('frontmatter and top-level drafting aliases combine, and an invalid alias is never hidden', () => {
  const combined = canonical({
    incoming: { content_origin: 'mixed', content_origin_basis: 'mixed_composition', content_origin_drafting: [codexDraft] },
    origin: { drafting: [claudeEdit, codexDraft] },
  });
  assert.deepEqual(combined.errors, []);
  assert.deepEqual(combined.frontmatter.content_origin_drafting, [codexDraft, claudeEdit]);
  const hidden = canonical({
    incoming: { content_origin: 'assistant', content_origin_basis: 'assistant_generated', content_origin_drafting: 'garbage' },
    origin: { drafting: [codexDraft] },
  });
  assert.ok(hidden.errors.some((error) => error.includes('drafting_not_array')));
  const { parseInput } = require('../bridge/provenance/src/note-journal-contract');
  const parsed = parseInput({ personality: 'codex', title: 'Drafted', content: BODY, drafting: [claudeEdit], content_origin_drafting: [codexDraft], frontmatter: { content_origin_drafting: [] } });
  assert.deepEqual(parsed.frontmatter.content_origin_drafting, [codexDraft, claudeEdit]);
  assert.throws(() => parseInput({ personality: 'codex', title: 'Drafted', content: BODY, drafting: [codexDraft], frontmatter: { content_origin_drafting: {} } }), /drafting_not_array/);
});

test('stored served entries resent by a caller are not re-resolved as fresh claims', () => {
  const served = { kind: 'assistant_draft', harness: 'codex', model: 'gpt-5-codex', model_evidence: 'served', served_ref: 'resp-1' };
  const result = mergeContentOriginDrafting({ existing: [served], incoming: [served], origin: 'assistant' });
  assert.deepEqual(result.entries, [served]);
});

test('Codex and Claude parseInput carry top-level drafting into canonical frontmatter', () => {
  const { parseInput } = require('../bridge/provenance/src/note-journal-contract');
  for (const [personality, entry] of [['codex', codexDraft], ['claude-code', claudeEdit]]) {
    const parsed = parseInput({ personality, title: 'Drafted', content: BODY, content_origin: 'assistant', content_origin_basis: 'assistant_generated', drafting: [entry] });
    assert.deepEqual(parsed.frontmatter.content_origin_drafting, [entry]);
    const viaFrontmatter = parseInput({ personality, title: 'Drafted', content: BODY, frontmatter: { content_origin_drafting: [entry] } });
    assert.deepEqual(viaFrontmatter.frontmatter.content_origin_drafting, [entry]);
  }
});

test('harness-neutral capture carries declared drafting, never actor.model', () => {
  const { normalizeCaptureEvent, frontmatterForCaptureEvent } = require('../bridge/capture/src/universal-capture');
  const event = normalizeCaptureEvent({
    captureEventId: 'capture-9',
    text: BODY,
    source: 'codex',
    actor: { type: 'assistant', name: 'codex', model: 'should-not-appear' },
    content_origin: 'assistant',
    content_origin_basis: 'assistant_generated',
    content_origin_drafting: [codexDraft],
  });
  const frontmatter = frontmatterForCaptureEvent(event);
  assert.deepEqual(frontmatter.content_origin_drafting, [codexDraft]);
  assert.doesNotMatch(JSON.stringify(frontmatter.content_origin_drafting), /should-not-appear/);
  const noDrafting = frontmatterForCaptureEvent(normalizeCaptureEvent({
    captureEventId: 'capture-10', text: BODY, source: 'codex', actor: { type: 'assistant', model: 'x' },
  }));
  assert.equal(noDrafting.content_origin_drafting, undefined);
  assert.throws(() => normalizeCaptureEvent({
    captureEventId: 'capture-11', text: BODY, source: 'codex',
    content_origin_drafting: [{ ...codexDraft, model_evidence: 'served', served_ref: 'r' }],
  }), /served_unresolved/);
});

test('rendered readback projection keeps valid human and excludes AI, mixed, and tampered history', () => {
  const human = canonical({
    incoming: { content_origin: 'human', content_origin_basis: 'verbatim_user', content_origin_source: receipt() },
    origin: { resolveUserSource: resolveUserSource() },
  }).frontmatter;
  const project = (frontmatter) => projectNoteMarkdown(`${renderFrontmatter(frontmatter)}${BODY}\n`, { resolveUserSource: resolveUserSource() });
  assert.equal(project(human).human_evidence_eligible, true);

  const assistant = canonical({ incoming: { content_origin: 'assistant', content_origin_basis: 'assistant_generated' }, origin: { drafting: [codexDraft] } }).frontmatter;
  const rendered = `${renderFrontmatter(assistant)}${BODY}\n`;
  assert.match(rendered, /content_origin_drafting: \[\{/);
  assert.equal(project(assistant).human_evidence_eligible, false);

  const mixed = canonical({ incoming: { content_origin: 'mixed', content_origin_basis: 'mixed_composition' } }).frontmatter;
  assert.equal(project(mixed).human_evidence_eligible, false);
  assert.equal(project({ ...human, content_origin_drafting: [codexDraft] }).human_evidence_eligible, false);
  assert.equal(project({ ...human, content_origin_drafting: 'garbage' }).human_evidence_eligible, false);
});
