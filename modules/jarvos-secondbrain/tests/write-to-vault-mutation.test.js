'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const { createNoteMutationOperation, writeNoteFile } = require('../packages/jarvos-secondbrain-notes/src/write-to-vault');
const { createConfiguredVaultMutationService } = require('../src/vault-mutation-service');

function withVault(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-note-mutation-'));
  const previous = {
    JARVOS_VAULT_DIR: process.env.JARVOS_VAULT_DIR,
    JARVOS_NOTES_DIR: process.env.JARVOS_NOTES_DIR,
    JARVOS_JOURNAL_DIR: process.env.JARVOS_JOURNAL_DIR,
  };
  process.env.JARVOS_VAULT_DIR = root;
  process.env.JARVOS_NOTES_DIR = path.join(root, 'Notes');
  process.env.JARVOS_JOURNAL_DIR = path.join(root, 'Journal');
  try { return run({ root }); }
  finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const options = {
  vaultId: 'vault-a',
  vaultRelativePath: 'Notes/Stable.md',
  title: 'Stable',
  content: 'body',
  frontmatter: { status: 'draft' },
};

test('note mutation factory requires a caller-owned stable operation id', () => {
  assert.throws(() => createNoteMutationOperation(options), /operationId is required/);
  const created = createNoteMutationOperation({ ...options, operationId: 'note-intent-0001', sequence: 7 });
  assert.equal(created.operationId, 'note-intent-0001');
  assert.equal(created.sequence, 7);
  assert.equal(created.operationKind, 'create');
});

test('note mutation factory keeps the supplied operation id for an existing-note retry', () => {
  const existing = '---\njarvos_note_id: "stable-note-id"\n---\n\n# Stable\n\nmobile prose\n';
  const operation = createNoteMutationOperation({ ...options, operationId: 'note-intent-0002', sequence: 8, existingContent: existing, existingFrontmatter: { jarvos_note_id: 'stable-note-id' } });
  assert.equal(operation.operationId, 'note-intent-0002');
  assert.equal(operation.sequence, 8);
  assert.equal(operation.noteId, 'stable-note-id');
  // The stored note carries no declaration, so this write is also the one that
  // gives it one; a whole-note replace is the only operation that can do both.
  assert.equal(operation.operationKind, 'replace');
  assert.match(operation.content, /content_origin_schema: jarvos-content-origin\/v1/);
  assert.match(operation.content, /mobile prose/);
  assert.match(operation.content, /# Stable\n\nbody/);
});

test('an existing note that already carries the canonical declaration keeps the append-only transform', () => {
  const existing = [
    '---',
    'jarvos_note_id: "declared-note-id"',
    'content_origin_schema: jarvos-content-origin/v1',
    'content_origin: unknown',
    'content_origin_basis: unknown',
    'human_evidence_eligible: false',
    '---',
    '',
    '# Stable',
    '',
    'mobile prose',
    '',
  ].join('\n');
  const operation = createNoteMutationOperation({
    ...options,
    operationId: 'note-intent-0003',
    existingContent: existing,
    existingFrontmatter: {
      jarvos_note_id: 'declared-note-id',
      content_origin_schema: 'jarvos-content-origin/v1',
      content_origin: 'unknown',
      content_origin_basis: 'unknown',
      human_evidence_eligible: false,
    },
  });

  // Nothing about the stored declaration changes, so the write stays an append.
  assert.equal(operation.operationKind, 'transform');
  assert.equal(operation.transformName, 'note-append-body');
  assert.deepEqual(operation.replayPayload, { noteId: 'declared-note-id', body: '# Stable\n\nbody' });
});

test('injected writer reports the identity carried by the submitted operation', () => {
  withVault(({ root }) => {
    let submitted;
    const result = writeNoteFile({
      title: 'Created through Obsidian',
      content: 'Body',
      operationId: 'note-operation-created-identity',
      vaultId: 'vault-test',
      vaultRoot: root,
      mutationExecutor(operation) {
        submitted = operation;
        return { status: 'committed' };
      },
    });
    assert.equal(result.noteId, submitted.noteId);
  });
});

test('canonical note writes persist origin metadata, default missing declarations to unknown, and strip adoption state', () => {
  withVault(({ root }) => {
    const result = writeNoteFile({
      title: 'Provenance note',
      content: 'Generated context stays searchable but is not user evidence.',
      frontmatter: {
        status: 'draft',
        type: 'reference',
        project: 'PROVENANCE',
        author: 'jarvis',
        content_origin: 'assistant',
        content_origin_basis: 'assistant_generated',
        content_adoption: { state: 'accepted' },
      },
      operationId: 'note-provenance-0001',
      vaultId: 'vault-provenance',
      vaultRoot: root,
      mutationExecutor(operation) {
        const target = path.join(root, operation.vaultRelativePath);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, operation.content, 'utf8');
        return { status: 'committed', obsidian: 'acknowledged' };
      },
    });

    const content = fs.readFileSync(result.path, 'utf8');
    assert.match(content, /content_origin_schema: jarvos-content-origin\/v1/);
    assert.match(content, /content_origin: assistant/);
    assert.match(content, /content_origin_basis: assistant_generated/);
    assert.doesNotMatch(content, /content_adoption/);
  });
});

test('canonical note writes make an omitted origin explicit unknown', () => {
  withVault(({ root }) => {
    const result = writeNoteFile({
      title: 'Undeclared note',
      content: 'A note without a provenance declaration remains context-only.',
      operationId: 'note-provenance-unknown-0001',
      vaultId: 'vault-provenance',
      vaultRoot: root,
      mutationExecutor(operation) {
        const target = path.join(root, operation.vaultRelativePath);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, operation.content, 'utf8');
        return { status: 'committed', obsidian: 'acknowledged' };
      },
    });

    const content = fs.readFileSync(result.path, 'utf8');
    assert.match(content, /content_origin_schema: jarvos-content-origin\/v1/);
    assert.match(content, /content_origin: unknown/);
    assert.match(content, /content_origin_basis: unknown/);
    assert.match(content, /human_evidence_eligible: false/);
  });
});

const { cleanNoteContent, digestText } = require('../bridge/provenance/src/content-origin-contract');

function commitToDisk(root) {
  return (operation) => {
    const target = path.join(root, operation.vaultRelativePath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, operation.content, 'utf8');
    return { status: 'committed', obsidian: 'acknowledged' };
  };
}

function userReceipt({ title, content, captureEventId = 'capture-user-0001', contentDigest }) {
  return {
    capture_event_id: captureEventId,
    actor: 'user',
    source_digest: digestText(content),
    content_digest: contentDigest || digestText(cleanNoteContent(content, title)),
  };
}

test('a human origin claim without a verifiable receipt is written as unknown', () => {
  withVault(({ root }) => {
    const title = 'Forged human note';
    const content = 'Assistant prose that claims to be the user.';
    for (const [index, extra] of [
      {},
      // A well-formed receipt is still unverifiable without an injected resolver.
      { content_origin_source: userReceipt({ title, content }) },
    ].entries()) {
      const result = writeNoteFile({
        title: `${title} ${index}`,
        content,
        frontmatter: {
          content_origin: 'human',
          content_origin_basis: 'verbatim_user',
          human_evidence_eligible: true,
          ...extra,
        },
        operationId: `note-provenance-forged-000${index}`,
        vaultId: 'vault-provenance',
        vaultRoot: root,
        mutationExecutor: commitToDisk(root),
      });

      const written = fs.readFileSync(result.path, 'utf8');
      assert.match(written, /content_origin_schema: jarvos-content-origin\/v1/);
      assert.match(written, /content_origin: unknown/);
      assert.match(written, /content_origin_basis: unknown/);
      assert.match(written, /human_evidence_eligible: false/);
      assert.doesNotMatch(written, /content_origin_source/);
    }
  });
});

test('a human origin claim with a resolvable receipt is written as human evidence', () => {
  withVault(({ root }) => {
    const title = 'User thought';
    const content = 'The market itself grows when launch costs fall.';
    const receipt = userReceipt({ title, content });
    const result = writeNoteFile({
      title,
      content,
      frontmatter: { content_origin: 'human', content_origin_basis: 'verbatim_user', content_origin_source: receipt },
      resolveUserSource: (id) => (id === receipt.capture_event_id ? { capture_event_id: id, actor: 'user', text: content } : null),
      operationId: 'note-provenance-human-0001',
      vaultId: 'vault-provenance',
      vaultRoot: root,
      mutationExecutor: commitToDisk(root),
    });

    const written = fs.readFileSync(result.path, 'utf8');
    assert.match(written, /content_origin_schema: jarvos-content-origin\/v1/);
    assert.match(written, /content_origin: human/);
    assert.match(written, /content_origin_basis: verbatim_user/);
    assert.match(written, /human_evidence_eligible: true/);
    assert.match(written, /content_origin_source:/);
  });
});

test('a human receipt whose content digest does not match the note fails closed', () => {
  withVault(({ root }) => {
    const title = 'Edited user thought';
    const content = 'Assistant rewrite of what the user said.';
    const receipt = userReceipt({ title, content, contentDigest: digestText('What the user actually said.') });
    const result = writeNoteFile({
      title,
      content,
      frontmatter: { content_origin: 'human', content_origin_basis: 'user_derived', content_origin_source: receipt },
      resolveUserSource: (id) => ({ capture_event_id: id, actor: 'user', text: content }),
      operationId: 'note-provenance-mismatch-0001',
      vaultId: 'vault-provenance',
      vaultRoot: root,
      mutationExecutor: commitToDisk(root),
    });

    const written = fs.readFileSync(result.path, 'utf8');
    assert.match(written, /content_origin: unknown/);
    assert.match(written, /human_evidence_eligible: false/);
    assert.doesNotMatch(written, /content_origin_source/);
  });
});

test('material note updates without a declaration downgrade inherited provenance to unknown', () => {
  withVault(({ root }) => {
    const execute = (operation) => {
      const target = path.join(root, operation.vaultRelativePath);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      if (operation.operationKind === 'create') fs.writeFileSync(target, operation.content, 'utf8');
      else if (operation.operationKind === 'replace') fs.writeFileSync(target, operation.content, 'utf8');
      else fs.writeFileSync(target, `${fs.readFileSync(target, 'utf8').trimEnd()}\n\n${operation.replayPayload.body}\n`, 'utf8');
      return { status: 'committed', obsidian: 'acknowledged' };
    };
    const context = (operationId) => ({
      operationId,
      vaultId: 'vault-provenance-update',
      vaultRoot: root,
      mutationExecutor: execute,
    });
    const first = writeNoteFile({
      title: 'Stable provenance',
      content: 'Assistant draft.',
      frontmatter: { status: 'draft', type: 'reference', project: 'PROVENANCE', author: 'jarvis', content_origin: 'assistant', content_origin_basis: 'assistant_generated' },
      ...context('note-provenance-0002'),
    });
    writeNoteFile({
      title: 'Stable provenance',
      content: 'A later maintenance update.',
      ...context('note-provenance-0003'),
    });
    const content = fs.readFileSync(first.path, 'utf8');
    assert.match(content, /content_origin: unknown/);
    assert.match(content, /content_origin_basis: unknown/);
    assert.doesNotMatch(content, /content_origin: assistant/);
  });
});

function settled(value) {
  return {
    then(fn) { try { fn(value); return this; } catch (error) { this.error = error; return this; } },
    catch(fn) { if (this.error) fn(this.error); return this; },
  };
}

function fakeObsidianEvaluator(root) {
  const files = new Map();
  const calls = { create: 0, process: 0, read: 0 };
  const vault = {
    adapter: { getBasePath: () => root },
    getFileByPath(target) { return files.get(target) || null; },
    create(target, content) {
      calls.create += 1;
      const file = { path: target, content };
      files.set(target, file);
      fs.mkdirSync(path.dirname(path.join(root, target)), { recursive: true });
      fs.writeFileSync(path.join(root, target), content, 'utf8');
      return settled(file);
    },
    process(file, transform) {
      calls.process += 1;
      file.content = transform(file.content);
      fs.writeFileSync(path.join(root, file.path), file.content, 'utf8');
      return settled(file);
    },
    read(file) { calls.read += 1; return settled(file.content); },
  };
  const context = { app: { vault }, TextDecoder, Uint8Array, atob: (value) => Buffer.from(value, 'base64').toString('binary'), JSON };
  context.globalThis = context;
  return {
    calls,
    files,
    evaluate(code) {
      const raw = vm.runInNewContext(code, context);
      return typeof raw === 'string' ? JSON.parse(raw) : raw;
    },
  };
}

test('configured composition creates through Obsidian and acknowledges with app-owned readback', () => {
  withVault(({ root }) => {
    const fake = fakeObsidianEvaluator(root);
    const service = createConfiguredVaultMutationService({
      vaultRoot: root,
      vaultId: 'vault-note-composition',
      source: 'bridge.test-note',
      adapterOptions: {
        ledgerPath: path.join(root, '.state', 'ledger.json'),
        probe: () => ({ state: 'available', vaultId: 'vault-note-composition' }),
        evaluate: fake.evaluate,
        maxPollAttempts: 2,
      },
    });
    const context = service.createWriteContext({ vaultRelativePath: 'Notes/App Owned.md', intentId: 'note-app-owned-intent-0001' });
    const result = writeNoteFile({ title: 'App Owned', content: 'Created through the app.', ...context });
    assert.equal(result.receipt.status, 'committed');
    assert.deepEqual(result.artifactReceipt.artifacts, [{
      schemaVersion: 'jarvos.artifact-receipt.v1',
      kind: 'note',
      vaultRelativePath: 'Notes/App Owned.md',
      outcome: 'committed',
    }]);
    assert.equal(result.receipt.obsidian, 'acknowledged');
    assert.equal(fake.calls.create, 1);
    assert.ok(fake.calls.read >= 1);
    assert.match(fs.readFileSync(result.path, 'utf8'), /Created through the app\./);
  });
});

test('existing note transform preserves the latest app content and stable identity', () => {
  withVault(({ root }) => {
    const fake = fakeObsidianEvaluator(root);
    const service = createConfiguredVaultMutationService({
      vaultRoot: root,
      vaultId: 'vault-note-update',
      source: 'bridge.test-note',
      adapterOptions: { ledgerPath: path.join(root, '.state', 'ledger.json'), probe: () => ({ state: 'available', vaultId: 'vault-note-update' }), evaluate: fake.evaluate, maxPollAttempts: 2 },
    });
    const first = writeNoteFile({ title: 'Concurrent', content: 'First agent prose.', ...service.createWriteContext({ vaultRelativePath: 'Notes/Concurrent.md', intentId: 'note-concurrent-intent-01' }) });
    const file = fake.files.get('Notes/Concurrent.md');
    file.content = `${file.content.trimEnd()}\n\nMobile prose survives.\n`;
    fs.writeFileSync(first.path, file.content, 'utf8');
    const second = writeNoteFile({ title: 'Concurrent', content: 'Second agent prose.', ...service.createWriteContext({ vaultRelativePath: 'Notes/Concurrent.md', intentId: 'note-concurrent-intent-02' }) });
    assert.equal(second.receipt.status, 'committed');
    assert.equal(fake.calls.process, 1);
    const content = fs.readFileSync(second.path, 'utf8');
    assert.match(content, /Mobile prose survives\./);
    assert.match(content, /Second agent prose\./);
    assert.equal((content.match(/jarvos_note_id:/g) || []).length, 1);
  });
});

test('wrong-vault capability retains a durable plan and never raw-writes', () => {
  withVault(({ root }) => {
    const service = createConfiguredVaultMutationService({
      vaultRoot: root,
      vaultId: 'vault-note-unavailable',
      source: 'bridge.test-note',
      adapterOptions: { ledgerPath: path.join(root, '.state', 'ledger.json'), probe: () => ({ state: 'wrong_vault' }) },
    });
    const result = writeNoteFile({ title: 'Offline', content: 'Must not bypass Obsidian.', ...service.createWriteContext({ vaultRelativePath: 'Notes/Offline.md', intentId: 'note-unavailable-intent' }) });
    assert.equal(result.written, false);
    assert.equal(result.receipt.status, 'unavailable');
    assert.equal(fs.existsSync(result.path), false);
    assert.equal(service.adapter.ledger.get('note-unavailable-intent').status, 'planned');
  });
});

test('host-owned absence proof permits only a durable offline create pending reconciliation', () => {
  withVault(({ root }) => {
    const service = createConfiguredVaultMutationService({
      vaultRoot: root,
      vaultId: 'vault-note-offline',
      source: 'bridge.test-note',
      proveObsidianAbsent: () => true,
      adapterOptions: { ledgerPath: path.join(root, '.state', 'ledger.json'), probe: () => ({ state: 'wrong_vault' }) },
    });
    const result = writeNoteFile({ title: 'Offline Create', content: 'Queue this for Sync.', ...service.createWriteContext({ vaultRelativePath: 'Notes/Offline Create.md', intentId: 'note-offline-create-01' }) });
    assert.equal(result.written, false);
    assert.equal(result.savedLocally, true);
    assert.equal(result.receipt.status, 'saved_locally_sync_pending');
    assert.equal(result.artifactReceipt.artifacts[0].outcome, 'saved_locally_sync_pending');
    assert.equal(result.artifactReceipt.artifacts[0].vaultRelativePath, 'Notes/Offline Create.md');
    assert.equal(service.adapter.ledger.get('note-offline-create-01').status, 'local_applied');
    assert.match(fs.readFileSync(result.path, 'utf8'), /Queue this for Sync\./);
  });
});

test('caller source text cannot grant offline-write authority', () => {
  withVault(({ root }) => {
    const service = createConfiguredVaultMutationService({
      vaultRoot: root,
      vaultId: 'vault-source-boundary',
      source: 'bridge.trusted-source',
      proveObsidianAbsent: () => true,
      adapterOptions: { ledgerPath: path.join(root, '.state', 'ledger.json'), probe: () => ({ state: 'app_stopped' }) },
    });
    assert.throws(() => service.execute({
      schemaVersion: 1,
      operationId: 'forged-source-operation',
      vaultId: service.vaultId,
      vaultRelativePath: 'Notes/Forged.md',
      sequence: 1,
      operationKind: 'create',
      content: 'must not write',
      source: 'forged.offline-authority',
    }), /cannot override/);
    assert.throws(() => service.createWriteContext({
      vaultRelativePath: 'Notes/Forged Context.md',
      intentId: 'forged-context-operation',
      operationSource: 'forged.offline-authority',
    }), /cannot override/);
    assert.throws(() => service.createMarkdownFile({
      vaultRelativePath: 'Notes/Forged High Level.md',
      nextContent: 'must not write',
      operationId: 'forged-high-level-operation',
      source: 'forged.offline-authority',
    }), /cannot override/);
    assert.equal(fs.existsSync(path.join(root, 'Notes', 'Forged.md')), false);
    assert.equal(fs.existsSync(path.join(root, 'Notes', 'Forged High Level.md')), false);
    assert.equal(service.adapter.ledger.get('forged-source-operation'), null);
    assert.equal(service.adapter.ledger.get('forged-context-operation'), null);
    assert.equal(service.adapter.ledger.get('forged-high-level-operation'), null);
  });
});

test('a busy or timed-out Obsidian path queues without opening a disk writer', () => {
  withVault(({ root }) => {
    const service = createConfiguredVaultMutationService({
      vaultRoot: root,
      vaultId: 'vault-busy-boundary',
      source: 'bridge.busy-boundary',
      adapterOptions: { ledgerPath: path.join(root, '.state', 'ledger.json'), probe: () => ({ state: 'app_busy' }) },
    });
    const result = writeNoteFile({ title: 'Busy', content: 'Do not raw write.', ...service.createWriteContext({ vaultRelativePath: 'Notes/Busy.md', intentId: 'busy-timeout-operation' }) });
    assert.equal(result.receipt.status, 'unavailable');
    assert.equal(result.savedLocally, false);
    assert.equal(fs.existsSync(result.path), false);
    assert.equal(service.adapter.ledger.get('busy-timeout-operation').status, 'planned');
  });
});

test('write contexts do not reserve empty FIFO slots before full submission', () => {
  withVault(({ root }) => {
    const service = createConfiguredVaultMutationService({
      vaultRoot: root,
      vaultId: 'vault-atomic-submission',
      source: 'bridge.atomic-submission',
      adapterOptions: { ledgerPath: path.join(root, '.state', 'ledger.json'), probe: () => ({ state: 'wrong_vault' }) },
    });
    const firstContext = service.createWriteContext({ vaultRelativePath: 'Notes/Ordered.md', operationId: 'ordered-context-first' });
    const secondContext = service.createWriteContext({ vaultRelativePath: 'Notes/Ordered.md', operationId: 'ordered-context-second' });
    assert.equal(Object.keys(service.adapter.ledger.read().operations).length, 0);
    const operation = (context, content) => ({ schemaVersion: 1, operationId: context.operationId, vaultId: context.vaultId, vaultRelativePath: 'Notes/Ordered.md', sequence: context.sequence, operationKind: 'create', content, source: context.source });
    secondContext.mutationExecutor(operation(secondContext, 'submitted first'));
    firstContext.mutationExecutor(operation(firstContext, 'submitted second'));
    assert.equal(service.adapter.ledger.get('ordered-context-second').operation.sequence, 1);
    assert.equal(service.adapter.ledger.get('ordered-context-first').operation.sequence, 2);
  });
});

const crypto = require('node:crypto');
const {
  NOTE_BODY_PRESERVATION_REFUSED,
  NOTE_EXPECTED_STATE_REFUSED,
} = require('../packages/jarvos-secondbrain-notes/src/write-to-vault');
const { frontmatterToObject, parseFrontmatter } = require('../packages/jarvos-secondbrain-notes/src/lib/note-schema');

// A stored note that predates the contract. The trailing blank line is the
// point: the raw remainder is what has to survive, not a trimmed likeness.
const STORED_LEGACY_NOTE = [
  '---',
  'status: active',
  'type: reference',
  'project: ""',
  'created: 2026-05-01',
  'updated: 2026-05-01',
  'author: andrew',
  '---',
  '',
  '# Stored Legacy',
  '',
  'Prose that predates the contract.',
  '',
  '',
].join('\n');

// The same note once it already carries the unknown declaration.
const STORED_DECLARED_NOTE = [
  '---',
  'status: active',
  'type: reference',
  'project: ""',
  'created: 2026-05-01',
  'updated: 2026-05-01',
  'author: andrew',
  'content_origin_schema: jarvos-content-origin/v1',
  'content_origin: unknown',
  'content_origin_basis: unknown',
  'human_evidence_eligible: false',
  '---',
  '',
  '# Stored Legacy',
  '',
  'Prose that predates the contract.',
  '',
  '',
].join('\n');

// Raw, untrimmed remainder, exactly as the audit and the writer compute it.
function remainderOf(markdown) {
  const parsed = parseFrontmatter(String(markdown || ''));
  return String(parsed?.remainder ?? markdown ?? '');
}

function sha256Utf8(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

// A metadata-only provenance repair: the caller's content is the stored body.
function repairOptions(existingContent = STORED_LEGACY_NOTE) {
  return {
    operationId: 'note-provenance-repair-0001',
    vaultId: 'vault-provenance-repair',
    vaultRelativePath: 'Notes/Stored Legacy.md',
    title: 'Stored Legacy',
    content: remainderOf(existingContent).trim(),
    frontmatter: {
      content_origin_schema: 'jarvos-content-origin/v1',
      content_origin: 'unknown',
      content_origin_basis: 'unknown',
      human_evidence_eligible: false,
    },
    existingContent,
    existingFrontmatter: frontmatterToObject(parseFrontmatter(existingContent)),
  };
}

test('a provenance rewrite re-renders the body by default, unchanged', () => {
  const operation = createNoteMutationOperation(repairOptions());

  assert.equal(operation.operationKind, 'replace');
  assert.equal(operation.expectedContent, STORED_LEGACY_NOTE);
  assert.equal(operation.expectedHash, sha256Utf8(STORED_LEGACY_NOTE));
  assert.match(operation.content, /content_origin: unknown/);
  // The default render puts the renderer's separator line ahead of the body and
  // ends it with a single newline, so the raw remainder is not the stored one.
  assert.equal(remainderOf(operation.content), `\n${remainderOf(STORED_LEGACY_NOTE).trimEnd()}\n`);
  assert.notEqual(remainderOf(operation.content), remainderOf(STORED_LEGACY_NOTE));
});

test('the metadata-only option preserves the stored body remainder byte for byte', () => {
  const operation = createNoteMutationOperation({ ...repairOptions(), preserveExistingBodyBytes: true });

  assert.equal(operation.operationKind, 'replace');
  // Compare-and-swap and mutation boundary semantics are untouched.
  assert.equal(operation.expectedContent, STORED_LEGACY_NOTE);
  assert.equal(operation.expectedHash, sha256Utf8(STORED_LEGACY_NOTE));
  // Not "equivalent after trimming": the same bytes, trailing blank line included.
  assert.equal(remainderOf(operation.content), remainderOf(STORED_LEGACY_NOTE));
  assert.equal(operation.content.endsWith(remainderOf(STORED_LEGACY_NOTE)), true);
  // Only the frontmatter block changed, and it is still canonical.
  assert.match(operation.content, /content_origin_schema: jarvos-content-origin\/v1/);
  assert.match(operation.content, /content_origin: unknown/);
  assert.match(operation.content, /human_evidence_eligible: false/);
  assert.match(operation.content, /author: andrew/);
});

test('the metadata-only option is refused rather than dropping caller prose', () => {
  const refusalFor = (overrides) => {
    try {
      createNoteMutationOperation({ ...repairOptions(), preserveExistingBodyBytes: true, ...overrides });
    } catch (error) {
      assert.equal(error.code, NOTE_BODY_PRESERVATION_REFUSED);
      return error.reason;
    }
    return 'not_refused';
  };

  assert.equal(refusalFor({ existingContent: '', existingFrontmatter: {} }), 'not_an_existing_note');
  assert.equal(refusalFor({ appendEntry: 'a session thread line' }), 'append_entry_unsupported');
  // Prose the stored body does not already contain would be silently discarded.
  assert.equal(refusalFor({ content: 'Prose the stored note has never contained.' }), 'body_would_change');
  assert.equal(refusalFor({ preserveExistingBodyBytes: 'yes' }), 'option_not_boolean');
  // Nothing about the stored declaration changes, so there is no whole-note
  // replacement to make byte-preserving in the first place.
  assert.equal(refusalFor(repairOptions(STORED_DECLARED_NOTE)), 'not_a_provenance_rewrite');
});

test('the writeNoteFile path forwards the metadata-only option to the supported mutation', () => {
  withVault(({ root }) => {
    const notePath = path.join(root, 'Notes', 'Stored Legacy.md');
    fs.mkdirSync(path.dirname(notePath), { recursive: true });
    fs.writeFileSync(notePath, STORED_LEGACY_NOTE, 'utf8');
    const submitted = [];

    const write = (extra) => writeNoteFile({
      title: 'Stored Legacy',
      content: remainderOf(STORED_LEGACY_NOTE).trim(),
      frontmatter: {
        content_origin_schema: 'jarvos-content-origin/v1',
        content_origin: 'unknown',
        content_origin_basis: 'unknown',
        human_evidence_eligible: false,
      },
      operationId: `note-provenance-repair-${submitted.length}`,
      vaultId: 'vault-provenance-repair',
      vaultRoot: root,
      mutationExecutor(operation) {
        submitted.push(operation);
        return { status: 'committed', obsidian: 'acknowledged' };
      },
      ...extra,
    });

    // Default: the option is off, and the body is re-rendered as before.
    write({});
    assert.equal(submitted[0].operationKind, 'replace');
    assert.notEqual(remainderOf(submitted[0].content), remainderOf(STORED_LEGACY_NOTE));

    write({ preserveExistingBodyBytes: true });
    assert.equal(submitted[1].operationKind, 'replace');
    assert.equal(submitted[1].expectedHash, sha256Utf8(STORED_LEGACY_NOTE));
    assert.equal(remainderOf(submitted[1].content), remainderOf(STORED_LEGACY_NOTE));
    // The executor is the only thing that touches bytes; the stored note is
    // untouched by the factory itself.
    assert.equal(fs.readFileSync(notePath, 'utf8'), STORED_LEGACY_NOTE);
  });
});

// SUP-3959 (Astra P1): a caller that proved something about exact bytes must be
// able to bind the commit to those bytes rather than to the writer's own re-read.
function boundRepair(root, extra = {}) {
  return writeNoteFile({
    title: 'Stored Legacy',
    content: remainderOf(STORED_LEGACY_NOTE).trim(),
    frontmatter: {
      content_origin_schema: 'jarvos-content-origin/v1',
      content_origin: 'unknown',
      content_origin_basis: 'unknown',
      human_evidence_eligible: false,
    },
    operationId: 'note-provenance-bound-repair',
    vaultId: 'vault-provenance-repair',
    vaultRoot: root,
    preserveExistingBodyBytes: true,
    expectedExistingContent: STORED_LEGACY_NOTE,
    ...extra,
  });
}

// Executes a replace only while the note still hashes to the operation's guard,
// as the supported boundary does.
function guardedExecutor(root, submitted, beforeCommit = () => {}) {
  return (operation) => {
    submitted.push(operation);
    const target = path.join(root, operation.vaultRelativePath);
    beforeCommit(target);
    if (sha256Utf8(fs.readFileSync(target, 'utf8')) !== operation.expectedHash) return { status: 'conflict', obsidian: 'unacknowledged' };
    fs.writeFileSync(target, operation.content, 'utf8');
    return { status: 'committed', obsidian: 'acknowledged' };
  };
}

test('an expected-state write commits against the caller bytes and reports its binding', () => {
  withVault(({ root }) => {
    const notePath = path.join(root, 'Notes', 'Stored Legacy.md');
    fs.mkdirSync(path.dirname(notePath), { recursive: true });
    fs.writeFileSync(notePath, STORED_LEGACY_NOTE, 'utf8');
    const submitted = [];

    const result = boundRepair(root, { mutationExecutor: guardedExecutor(root, submitted) });

    assert.equal(result.receipt.status, 'committed');
    assert.equal(submitted.length, 1);
    assert.equal(submitted[0].operationKind, 'replace');
    assert.equal(submitted[0].expectedHash, sha256Utf8(STORED_LEGACY_NOTE));
    assert.deepEqual(result.stateBinding, {
      expectedHash: sha256Utf8(STORED_LEGACY_NOTE),
      contentHash: sha256Utf8(submitted[0].content),
    });
    const after = fs.readFileSync(notePath, 'utf8');
    assert.equal(sha256Utf8(after), result.stateBinding.contentHash);
    assert.equal(remainderOf(after), remainderOf(STORED_LEGACY_NOTE));
  });
});

test('an expected-state write never overwrites a change that landed after the caller read', () => {
  withVault(({ root }) => {
    const notePath = path.join(root, 'Notes', 'Stored Legacy.md');
    fs.mkdirSync(path.dirname(notePath), { recursive: true });
    const declared = STORED_DECLARED_NOTE.replace('content_origin: unknown', 'content_origin: assistant')
      .replace('content_origin_basis: unknown', 'content_origin_basis: assistant_generated');
    const edited = `${STORED_LEGACY_NOTE}Mobile prose.\n`;

    for (const concurrent of [declared, edited]) {
      // Already changed when the writer reads: refused before submission.
      fs.writeFileSync(notePath, concurrent, 'utf8');
      const early = [];
      assert.throws(
        () => boundRepair(root, { mutationExecutor: guardedExecutor(root, early) }),
        (error) => error.code === NOTE_EXPECTED_STATE_REFUSED && error.reason === 'changed_since_expected_state',
      );
      assert.equal(early.length, 0);
      assert.equal(fs.readFileSync(notePath, 'utf8'), concurrent);

      // Changed after the writer read but before commit: the submitted guard is
      // still the caller's bytes, so the executor rejects it.
      fs.writeFileSync(notePath, STORED_LEGACY_NOTE, 'utf8');
      const late = [];
      const result = boundRepair(root, {
        mutationExecutor: guardedExecutor(root, late, (target) => fs.writeFileSync(target, concurrent, 'utf8')),
      });
      assert.equal(result.receipt.status, 'conflict');
      assert.equal(result.written, false);
      assert.equal(late[0].expectedHash, sha256Utf8(STORED_LEGACY_NOTE));
      assert.equal(fs.readFileSync(notePath, 'utf8'), concurrent);
    }
  });
});

test('an expected state that cannot be enforced by a guarded replace is refused', () => {
  withVault(({ root }) => {
    const notePath = path.join(root, 'Notes', 'Stored Legacy.md');
    fs.mkdirSync(path.dirname(notePath), { recursive: true });
    const submitted = [];
    const refusal = (extra) => {
      try {
        boundRepair(root, { mutationExecutor: guardedExecutor(root, submitted), ...extra });
      } catch (error) {
        assert.equal(error.code, NOTE_EXPECTED_STATE_REFUSED);
        return error.reason;
      }
      return 'not_refused';
    };

    // No note on disk at all.
    assert.equal(refusal({}), 'changed_since_expected_state');
    assert.equal(refusal({ expectedExistingContent: '' }), 'expected_state_invalid');
    assert.equal(refusal({ expectedExistingContent: Buffer.from(STORED_LEGACY_NOTE) }), 'expected_state_invalid');
    // A canonical note takes the unguarded append transform, which cannot carry
    // the caller's expected state.
    fs.writeFileSync(notePath, STORED_DECLARED_NOTE, 'utf8');
    assert.equal(refusal({
      content: 'A later paragraph.',
      preserveExistingBodyBytes: false,
      expectedExistingContent: STORED_DECLARED_NOTE,
    }), 'expected_state_not_enforceable');
    assert.equal(submitted.length, 0);
    assert.equal(fs.readFileSync(notePath, 'utf8'), STORED_DECLARED_NOTE);
  });
});

// SUP-3959: a legacy note must not be able to keep taking new prose while
// staying undeclared. `note-append-body` and `session-thread-append` cannot
// carry frontmatter, so selecting one for an undeclared note was an escape from
// the contract that no later write would close on its own.
test('appending prose to an undeclared legacy note declares it in the same operation', () => {
  const operation = createNoteMutationOperation({
    operationId: 'note-legacy-append-0001',
    vaultId: 'vault-legacy-append',
    vaultRelativePath: 'Notes/Stored Legacy.md',
    title: 'Stored Legacy',
    content: 'A later paragraph the stored note has never contained.',
    existingContent: STORED_LEGACY_NOTE,
    existingFrontmatter: frontmatterToObject(parseFrontmatter(STORED_LEGACY_NOTE)),
  });

  assert.equal(operation.operationKind, 'replace');
  assert.equal(operation.transformName, undefined);
  // Compare-and-swap against the exact pre-state, as for any other rewrite.
  assert.equal(operation.expectedHash, sha256Utf8(STORED_LEGACY_NOTE));
  assert.match(operation.content, /content_origin_schema: jarvos-content-origin\/v1/);
  assert.match(operation.content, /content_origin: unknown/);
  assert.match(operation.content, /content_origin_basis: unknown/);
  assert.match(operation.content, /human_evidence_eligible: false/);
  // The stored `author: andrew` line is carried, and inferred from for nothing.
  assert.match(operation.content, /author: andrew/);
  assert.doesNotMatch(operation.content, /content_origin: human/);
  // Both the stored prose and the new prose are in the committed content.
  assert.match(operation.content, /Prose that predates the contract\./);
  assert.match(operation.content, /A later paragraph the stored note has never contained\./);
});

test('a session-thread append to an undeclared legacy note declares it too', () => {
  const operation = createNoteMutationOperation({
    operationId: 'note-legacy-append-0002',
    vaultId: 'vault-legacy-append',
    vaultRelativePath: 'Notes/Stored Legacy.md',
    title: 'Stored Legacy',
    content: remainderOf(STORED_LEGACY_NOTE).trim(),
    appendEntry: '## Agent checkpoint\n\nAgent-written thread entry.',
    existingContent: STORED_LEGACY_NOTE,
    existingFrontmatter: frontmatterToObject(parseFrontmatter(STORED_LEGACY_NOTE)),
  });

  assert.equal(operation.operationKind, 'replace');
  assert.equal(operation.transformName, undefined);
  assert.match(operation.content, /content_origin_schema: jarvos-content-origin\/v1/);
  assert.match(operation.content, /content_origin: unknown/);
  assert.match(operation.content, /Prose that predates the contract\./);
  assert.match(operation.content, /Agent-written thread entry\./);
});

test('the writeNoteFile path leaves no undeclared note behind after appending to one', () => {
  withVault(({ root }) => {
    const notePath = path.join(root, 'Notes', 'Stored Legacy.md');
    fs.mkdirSync(path.dirname(notePath), { recursive: true });
    fs.writeFileSync(notePath, STORED_LEGACY_NOTE, 'utf8');
    const submitted = [];

    // Executes whichever operation the factory chose, so the assertion below is
    // about the bytes on disk, not only about the operation shape.
    const execute = (operation) => {
      submitted.push(operation);
      const target = path.join(root, operation.vaultRelativePath);
      if (operation.operationKind === 'transform') {
        const current = fs.readFileSync(target, 'utf8');
        fs.writeFileSync(target, `${current.trimEnd()}\n\n${operation.replayPayload.body}\n`, 'utf8');
      } else {
        fs.writeFileSync(target, operation.content, 'utf8');
      }
      return { status: 'committed', obsidian: 'acknowledged' };
    };

    writeNoteFile({
      title: 'Stored Legacy',
      content: 'A later paragraph with no declaration attached.',
      operationId: 'note-legacy-append-writefile-0001',
      vaultId: 'vault-legacy-append',
      vaultRoot: root,
      mutationExecutor: execute,
    });

    assert.equal(submitted[0].operationKind, 'replace');
    const after = fs.readFileSync(notePath, 'utf8');
    assert.match(after, /content_origin_schema: jarvos-content-origin\/v1/);
    assert.match(after, /content_origin: unknown/);
    assert.match(after, /human_evidence_eligible: false/);
    assert.match(after, /Prose that predates the contract\./);
    assert.match(after, /A later paragraph with no declaration attached\./);

    // The note is canonical now, so the next append is an ordinary transform
    // again and the declaration it just gained survives it.
    writeNoteFile({
      title: 'Stored Legacy',
      content: 'A second later paragraph.',
      operationId: 'note-legacy-append-writefile-0002',
      vaultId: 'vault-legacy-append',
      vaultRoot: root,
      mutationExecutor: execute,
    });

    assert.equal(submitted[1].operationKind, 'transform');
    assert.equal(submitted[1].transformName, 'note-append-body');
    const afterSecond = fs.readFileSync(notePath, 'utf8');
    assert.match(afterSecond, /content_origin_schema: jarvos-content-origin\/v1/);
    assert.match(afterSecond, /A second later paragraph\./);
  });
});

test('package note writer contains no direct Markdown write primitive', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'packages', 'jarvos-secondbrain-notes', 'src', 'write-to-vault.js'), 'utf8');
  assert.doesNotMatch(source, /\b(?:writeFileSync|writeFile|appendFileSync|appendFile)\s*\(/);
});
