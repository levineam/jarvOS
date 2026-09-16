'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  KNOWN_SOURCE_KINDS,
  KNOWN_WRITER_PERSONALITIES,
  WRITER_BUCKETS,
  auditContentOrigin,
  applyContentOriginBackfill,
  classifyNoteRecord,
  planContentOriginBackfill,
  writerBucket,
} = require('../bridge/provenance/src/content-origin-audit');
const { CANONICAL_WRITERS } = require('../bridge/provenance/src/content-origin-writers');
const { SUPPORTED_PERSONALITIES } = require('../bridge/provenance/src/note-journal-contract');
const { renderJournalOriginMarker } = require('../bridge/provenance/src/content-origin-contract');
const { parseFrontmatter } = require('../packages/jarvos-secondbrain-notes/src/lib/note-schema');
const { writeNoteFile } = require('../packages/jarvos-secondbrain-notes/src/write-to-vault');
const { createAcknowledgedVaultMutationService } = require('./helpers/acknowledged-vault-mutation-service');

const DECLARED_NOTE = [
  '---',
  'status: draft',
  'type: draft',
  'project: ""',
  'created: 2026-09-01',
  'updated: 2026-09-01',
  'author: jarvis',
  'content_origin_schema: jarvos-content-origin/v1',
  'content_origin: assistant',
  'content_origin_basis: assistant_generated',
  'human_evidence_eligible: false',
  'source_personality: claude-code',
  '---',
  '',
  '# Declared Draft',
  '',
  'Assistant-generated body.',
  '',
].join('\n');

const LEGACY_NOTE = [
  '---',
  'status: active',
  'type: reference',
  'project: ""',
  'created: 2026-05-01',
  'updated: 2026-05-01',
  'author: andrew',
  '---',
  '',
  '# Legacy Note',
  '',
  'A note that predates the contract.',
  '',
].join('\n');

const UNDECLARED_NOTE = [
  '---',
  'status: active',
  'type: reference',
  'project: ""',
  'created: 2026-05-02',
  'updated: 2026-05-02',
  '---',
  '',
  '# Undeclared Note',
  '',
  'No declaration and no author.',
  '',
].join('\n');

// A note whose body does not open with its `# <title>` heading. The canonical
// writer would insert one, which is a prose edit, not a frontmatter repair.
const NO_HEADING_NOTE = [
  '---',
  'status: active',
  'type: reference',
  'project: ""',
  'created: 2026-05-03',
  'updated: 2026-05-03',
  '---',
  '',
  'Straight into the body with no heading.',
  '',
].join('\n');

// Raw remainder, exactly as the audit module computes it. Untrimmed on purpose.
function bodyOf(markdown) {
  const parsed = parseFrontmatter(String(markdown || ''));
  return String(parsed?.remainder ?? markdown ?? '');
}

function makeVault({ notes = {}, journal = {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-content-origin-audit-'));
  const notesDir = path.join(root, 'Notes');
  const journalDir = path.join(root, 'Journal');
  fs.mkdirSync(notesDir, { recursive: true });
  fs.mkdirSync(journalDir, { recursive: true });
  // Keys may be nested relative paths, e.g. 'Projects/Nested Note.md'.
  const write = (dir, name, content) => {
    const target = path.join(dir, ...name.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, 'utf8');
  };
  for (const [name, content] of Object.entries(notes)) write(notesDir, name, content);
  for (const [name, content] of Object.entries(journal)) write(journalDir, name, content);
  return { root, notesDir, journalDir };
}

// Recursive so a nested vault is snapshotted as thoroughly as a flat one. A
// symlink is recorded by its link text rather than followed, so the snapshot
// itself never leaves the tree it is supposed to be proving unchanged.
function snapshot(dir, prefix = '') {
  return fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).map((entry) => {
    const absolute = path.join(dir, entry.name);
    const label = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) return `${label}->${fs.readlinkSync(absolute)}`;
    if (entry.isDirectory()) return snapshot(absolute, label);
    return `${label}:${crypto.createHash('sha256').update(fs.readFileSync(absolute)).digest('hex')}`;
  }).join('\n');
}

function sha256Hex(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

// `beforeCommit` runs inside the executor, after the writer has read the note
// and built its operation but before the guarded commit: the narrowest race.
function supportedNoteWriter(vault, { beforeCommit } = {}) {
  const service = createAcknowledgedVaultMutationService(vault.root);
  // Forwards every option apply asks for, including the metadata-only
  // `preserveExistingBodyBytes` capability the preflight proved against and the
  // `expectedExistingContent` binding to the preflight bytes.
  return ({ title, content, frontmatter, preserveExistingBodyBytes, expectedExistingContent }) => {
    const filePath = path.join(vault.notesDir, `${title}.md`);
    const vaultRelativePath = path.relative(vault.root, filePath).split(path.sep).join('/');
    const context = service.createWriteContext({ vaultRelativePath, operationSource: 'test.content-origin-backfill' });
    const mutationExecutor = beforeCommit
      ? (operation) => {
        beforeCommit(operation);
        return context.mutationExecutor(operation);
      }
      : context.mutationExecutor;
    return writeNoteFile({ title, content, frontmatter, preserveExistingBodyBytes, expectedExistingContent, ...context, mutationExecutor });
  };
}

// A recovery seam that behaves like the supported boundary: it replaces the
// note only while the note still hashes to the guard it was given.
function guardedRestore(restores) {
  return ({ absolutePath, content, expectedHash }) => {
    restores.push({ absolutePath, expectedHash });
    if (sha256Hex(fs.readFileSync(absolutePath, 'utf8')) !== expectedHash) return { status: 'conflict' };
    fs.writeFileSync(absolutePath, content, 'utf8');
    return { status: 'committed' };
  };
}

function withNotesEnv(vault, fn) {
  const previous = process.env.VAULT_NOTES_DIR;
  process.env.VAULT_NOTES_DIR = vault.notesDir;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env.VAULT_NOTES_DIR;
    else process.env.VAULT_NOTES_DIR = previous;
  }
}

test('classifies declared, legacy-author, and undeclared notes without inferring human origin', () => {
  const declared = classifyNoteRecord({ markdown: DECLARED_NOTE, title: 'Declared Draft' });
  assert.equal(declared.contract, 'declared_v1');
  assert.equal(declared.content_origin, 'assistant');
  assert.equal(declared.human_evidence_eligible, false);
  assert.equal(declared.writer, 'personality:claude-code');

  const legacy = classifyNoteRecord({ markdown: LEGACY_NOTE, title: 'Legacy Note' });
  assert.equal(legacy.contract, 'legacy_author_only');
  assert.equal(legacy.content_origin, 'human');
  assert.equal(legacy.content_origin_basis, 'legacy_author');
  // author: andrew is read-time context, never programmatic human evidence.
  assert.equal(legacy.human_evidence_eligible, false);

  const undeclared = classifyNoteRecord({ markdown: UNDECLARED_NOTE, title: 'Undeclared Note' });
  assert.equal(undeclared.contract, 'undeclared');
  assert.equal(undeclared.content_origin, 'unknown');
  assert.equal(undeclared.human_evidence_eligible, false);
});

test('a stored human declaration whose receipt no longer binds the body resolves to unknown', () => {
  const markdown = [
    '---',
    'status: active',
    'type: reference',
    'project: ""',
    'created: 2026-05-02',
    'updated: 2026-05-02',
    'author: andrew',
    'content_origin_schema: jarvos-content-origin/v1',
    'content_origin: human',
    'content_origin_basis: verbatim_user',
    'human_evidence_eligible: true',
    `content_origin_source: ${JSON.stringify({
      capture_event_id: 'capture-stale',
      actor: 'user',
      source_digest: 'a'.repeat(64),
      content_digest: 'b'.repeat(64),
    })}`,
    '---',
    '',
    '# Stale Receipt',
    '',
    'A later rewrite that the receipt no longer covers.',
    '',
  ].join('\n');

  const record = classifyNoteRecord({ markdown, title: 'Stale Receipt' });
  assert.equal(record.content_origin, 'unknown');
  assert.equal(record.human_evidence_eligible, false);
  assert.equal(record.degraded, true);
});

test('the audit reports counts, mutates nothing, and emits no note or journal text', () => {
  const marker = renderJournalOriginMarker({
    cleanText: 'an assistant-generated idea',
    content_origin: 'assistant',
    content_origin_basis: 'assistant_generated',
  });
  const vault = makeVault({
    notes: {
      'Declared Draft.md': DECLARED_NOTE,
      'Legacy Note.md': LEGACY_NOTE,
      'Undeclared Note.md': UNDECLARED_NOTE,
    },
    journal: {
      '2026-09-01.md': [
        '## 💡 Ideas',
        '- an unmarked manual thought',
        '- an assistant-generated idea',
        marker,
        '',
      ].join('\n'),
    },
  });

  const notesBefore = snapshot(vault.notesDir);
  const journalBefore = snapshot(vault.journalDir);
  const report = auditContentOrigin({ notesDir: vault.notesDir, journalDir: vault.journalDir });

  assert.equal(report.read_only, true);
  assert.equal(report.mutated, false);
  assert.equal(report.notes.scanned, 3);
  assert.equal(report.notes.contract.declared_v1, 1);
  assert.equal(report.notes.contract.legacy_author_only, 1);
  assert.equal(report.notes.contract.undeclared, 1);
  assert.equal(report.notes.human_evidence_eligible, 0);
  assert.equal(report.notes.byWriter['personality:claude-code'], 1);

  assert.equal(report.journal.scannedDays, 1);
  assert.equal(report.journal.entries, 2);
  assert.equal(report.journal.marked, 1);
  assert.equal(report.journal.unmarked, 1);
  assert.equal(report.journal.origin.assistant, 1);
  // No resolver is available to an audit, so nothing can be human evidence.
  assert.equal(report.journal.human_evidence_eligible, 0);

  const serialized = JSON.stringify(report);
  assert.equal(serialized.includes('unmarked manual thought'), false);
  assert.equal(serialized.includes('Assistant-generated body'), false);
  assert.equal(serialized.includes('Declared Draft'), false);
  assert.doesNotMatch(serialized, /<!--\s*jarvos-content-origin/);

  assert.equal(snapshot(vault.notesDir), notesBefore);
  assert.equal(snapshot(vault.journalDir), journalBefore);
});

// SUP-3959: `source_personality` and `source` are free-text frontmatter. A real
// vault carries URLs, paths, and whole sentences in them, so a bucket that
// echoed the stored value put private content into a report that is supposed to
// be counts-only — and put it there in the DEFAULT report, which emits no
// filenames at all.
const SENSITIVE_PERSONALITY = 'https://private.example.com/andrew/thread?token=hunter2';
const SENSITIVE_SOURCE = 'Andrew told me over dinner that the acquisition closes Friday';

function noteWithAttribution({ created = '2026-05-04', personality, source }) {
  return [
    '---',
    'status: active',
    'type: reference',
    'project: ""',
    `created: ${created}`,
    `updated: ${created}`,
    ...(personality === undefined ? [] : [`source_personality: ${personality}`]),
    ...(source === undefined ? [] : [`source: ${source}`]),
    '---',
    '',
    '# Attributed Note',
    '',
    'Body prose that is none of the report\'s business.',
    '',
  ].join('\n');
}

test('the writer bucket is a closed vocabulary and never echoes a stored value', () => {
  assert.equal(writerBucket({ source_personality: 'codex' }), 'personality:codex');
  assert.equal(writerBucket({ source: CANONICAL_WRITERS[0].id }), `source_kind:${CANONICAL_WRITERS[0].id}`);
  // Anything outside the closed vocabulary aggregates; the value is dropped.
  assert.equal(writerBucket({ source_personality: SENSITIVE_PERSONALITY }), 'other_attributed');
  assert.equal(writerBucket({ source: SENSITIVE_SOURCE }), 'other_attributed');
  assert.equal(writerBucket({ source_personality: SENSITIVE_PERSONALITY, source: SENSITIVE_SOURCE }), 'other_attributed');
  // A non-string value cannot stringify its way into a key either.
  assert.equal(writerBucket({ source: { url: SENSITIVE_SOURCE } }), 'other_attributed');
  assert.equal(writerBucket({}), 'unattributed');
  assert.equal(writerBucket({ source_personality: '   ', source: '' }), 'unattributed');

  // A known personality still wins over an unknown source, and neither leaks.
  assert.equal(writerBucket({ source_personality: 'hermes', source: SENSITIVE_SOURCE }), 'personality:hermes');
});

test('the closed writer vocabulary tracks the supported personalities and the writer inventory', () => {
  // A personality added to the contract without being added here would quietly
  // become `other_attributed`, which is safe but silently less useful.
  assert.deepEqual([...KNOWN_WRITER_PERSONALITIES].sort(), [...SUPPORTED_PERSONALITIES].sort());
  assert.deepEqual([...KNOWN_SOURCE_KINDS].sort(), CANONICAL_WRITERS.map((writer) => writer.id).sort());
});

test('the audit never emits a stored personality or source value, with or without paths', () => {
  const vault = makeVault({
    notes: {
      'Hostile Attribution.md': noteWithAttribution({ personality: SENSITIVE_PERSONALITY, source: SENSITIVE_SOURCE }),
      'Known Writer.md': noteWithAttribution({ created: '2026-05-05', personality: 'codex' }),
      'Known Source.md': noteWithAttribution({ created: '2026-05-06', source: CANONICAL_WRITERS[0].id }),
      'Quiet Note.md': UNDECLARED_NOTE,
    },
  });

  const forbidden = [
    SENSITIVE_PERSONALITY,
    SENSITIVE_SOURCE,
    'private.example.com',
    'hunter2',
    'acquisition',
    'none of the report',
  ];

  const quiet = auditContentOrigin({ notesDir: vault.notesDir, journalDir: vault.journalDir });
  const quietSerialized = JSON.stringify(quiet);
  for (const secret of forbidden) assert.equal(quietSerialized.includes(secret), false, `default report leaked: ${secret}`);

  // The counts still say what they need to say.
  assert.equal(quiet.notes.scanned, 4);
  assert.equal(quiet.notes.byWriter.other_attributed, 1);
  assert.equal(quiet.notes.byWriter['personality:codex'], 1);
  assert.equal(quiet.notes.byWriter[`source_kind:${CANONICAL_WRITERS[0].id}`], 1);
  assert.equal(quiet.notes.byWriter.unattributed, 1);
  // Every emitted key comes from the closed vocabulary.
  for (const key of Object.keys(quiet.notes.byWriter)) assert.equal(WRITER_BUCKETS.includes(key), true, `unexpected bucket: ${key}`);

  const verbose = auditContentOrigin({ notesDir: vault.notesDir, journalDir: vault.journalDir, includePaths: true });
  const verboseSerialized = JSON.stringify(verbose);
  for (const secret of forbidden) assert.equal(verboseSerialized.includes(secret), false, `includePaths report leaked: ${secret}`);
  // Opting in adds normalized relative file paths, and nothing else.
  assert.deepEqual(verbose.notes.undeclaredPaths, [
    'Hostile Attribution.md',
    'Known Source.md',
    'Known Writer.md',
    'Quiet Note.md',
  ]);
  for (const relativePath of verbose.notes.undeclaredPaths) assert.match(relativePath, /^[^/].*\.md$/);

  const plan = planContentOriginBackfill({ notesDir: vault.notesDir, includePaths: true });
  const planSerialized = JSON.stringify(plan);
  for (const secret of forbidden) assert.equal(planSerialized.includes(secret), false, `plan leaked: ${secret}`);
});

test('the audit only reports paths when the operator opts in', () => {
  const vault = makeVault({ notes: { 'Undeclared Note.md': UNDECLARED_NOTE } });
  const quiet = auditContentOrigin({ notesDir: vault.notesDir, journalDir: vault.journalDir });
  assert.equal('undeclaredPaths' in quiet.notes, false);

  const verbose = auditContentOrigin({ notesDir: vault.notesDir, journalDir: vault.journalDir, includePaths: true });
  assert.deepEqual(verbose.notes.undeclaredPaths, ['Undeclared Note.md']);
});

test('the audit descends into nested note and journal directories', () => {
  // A flat scan under-reports coverage, and an under-report on a provenance
  // audit reads as "everything is declared" when it is not.
  const vault = makeVault({
    notes: {
      'Declared Draft.md': DECLARED_NOTE,
      'Projects/Legacy Note.md': LEGACY_NOTE,
      'Projects/Deep/Deeper/Undeclared Note.md': UNDECLARED_NOTE,
    },
    journal: {
      '2026-09-01.md': ['## 💡 Ideas', '- a top-level manual thought', ''].join('\n'),
      '2026/2026-09-02.md': ['## 💡 Ideas', '- a nested manual thought', ''].join('\n'),
      'archive/not-a-journal-day.md': ['## 💡 Ideas', '- ignored', ''].join('\n'),
    },
  });

  const report = auditContentOrigin({ notesDir: vault.notesDir, journalDir: vault.journalDir, includePaths: true });

  assert.equal(report.notes.scanned, 3);
  assert.equal(report.notes.nested, 2);
  assert.equal(report.notes.contract.legacy_author_only, 1);
  assert.equal(report.notes.contract.undeclared, 1);
  // Normalized POSIX relative paths, and only because includePaths was set.
  assert.deepEqual(report.notes.undeclaredPaths, [
    'Projects/Deep/Deeper/Undeclared Note.md',
    'Projects/Legacy Note.md',
  ]);

  // Nested journal days count; a file that is not a YYYY-MM-DD day does not.
  assert.equal(report.journal.scannedDays, 2);
  assert.equal(report.journal.entries, 2);

  const plan = planContentOriginBackfill({ notesDir: vault.notesDir, includePaths: true });
  assert.equal(plan.proposalCount, 2);
  assert.equal(plan.nestedProposals, 2);
  assert.deepEqual(plan.proposals.map((proposal) => proposal.relativePath).sort(), [
    'Projects/Deep/Deeper/Undeclared Note.md',
    'Projects/Legacy Note.md',
  ]);
});

test('the audit reports nested notes but never backfills them through the flat writer', () => {
  const vault = makeVault({ notes: { 'Projects/Legacy Note.md': LEGACY_NOTE } });
  const plan = planContentOriginBackfill({ notesDir: vault.notesDir, includePaths: true });
  const before = fs.readFileSync(path.join(vault.notesDir, 'Projects', 'Legacy Note.md'), 'utf8');

  const applied = withNotesEnv(vault, () => applyContentOriginBackfill({
    plan,
    apply: true,
    notesDir: vault.notesDir,
    writeNote: () => { throw new Error('the flat writer must not be reached for a nested note'); },
  }));

  // The supported writer resolves <notesDir>/<title>.md, so applying here would
  // create a second note at the root and leave the nested one undeclared.
  assert.equal(applied.results[0].status, 'skipped');
  assert.equal(applied.results[0].reason, 'writer_path_mismatch');
  assert.equal(applied.mutated, false);
  assert.equal(fs.readFileSync(path.join(vault.notesDir, 'Projects', 'Legacy Note.md'), 'utf8'), before);
  assert.equal(fs.existsSync(path.join(vault.notesDir, 'Legacy Note.md')), false);
});

test('the audit does not follow symlinked directories or notes', () => {
  const vault = makeVault({ notes: { 'Declared Draft.md': DECLARED_NOTE } });
  const outsideDir = path.join(vault.root, 'Outside');
  fs.mkdirSync(outsideDir, { recursive: true });
  fs.writeFileSync(path.join(outsideDir, 'Escaped Note.md'), UNDECLARED_NOTE, 'utf8');
  fs.symlinkSync(outsideDir, path.join(vault.notesDir, 'Linked Dir'));
  fs.symlinkSync(path.join(outsideDir, 'Escaped Note.md'), path.join(vault.notesDir, 'Linked Note.md'));

  const report = auditContentOrigin({ notesDir: vault.notesDir, journalDir: vault.journalDir, includePaths: true });

  // Only the one real note in the vault.
  assert.equal(report.notes.scanned, 1);
  assert.deepEqual(report.notes.undeclaredPaths, []);

  const plan = planContentOriginBackfill({ notesDir: vault.notesDir, includePaths: true });
  assert.equal(plan.proposalCount, 0);
});

test('backfill proposals are always unknown and never derived from author or personality', () => {
  const vault = makeVault({
    notes: {
      'Declared Draft.md': DECLARED_NOTE,
      'Legacy Note.md': LEGACY_NOTE,
      'Undeclared Note.md': UNDECLARED_NOTE,
    },
  });

  const plan = planContentOriginBackfill({ notesDir: vault.notesDir, includePaths: true });
  assert.equal(plan.proposalCount, 2);
  assert.deepEqual(plan.proposals.map((proposal) => proposal.relativePath).sort(), ['Legacy Note.md', 'Undeclared Note.md']);
  for (const proposal of plan.proposals) {
    assert.deepEqual(proposal.next, {
      content_origin_schema: 'jarvos-content-origin/v1',
      content_origin: 'unknown',
      content_origin_basis: 'unknown',
      human_evidence_eligible: false,
    });
    assert.match(proposal.sourceDigest, /^[a-f0-9]{64}$/);
  }
});

test('backfill planning withholds paths unless the operator asks for them', () => {
  const vault = makeVault({ notes: { 'Legacy Note.md': LEGACY_NOTE } });

  const quiet = planContentOriginBackfill({ notesDir: vault.notesDir });
  assert.equal(quiet.pathsIncluded, false);
  assert.equal(quiet.proposalCount, 1);
  assert.equal('relativePath' in quiet.proposals[0], false);
  assert.equal('title' in quiet.proposals[0], false);
  assert.equal('notesDir' in quiet, false);
  // Counts and digests are content-free and stay.
  assert.match(quiet.proposals[0].sourceDigest, /^[a-f0-9]{64}$/);

  const verbose = planContentOriginBackfill({ notesDir: vault.notesDir, includePaths: true });
  assert.equal(verbose.pathsIncluded, true);
  assert.equal(verbose.proposals[0].relativePath, 'Legacy Note.md');
});

test('backfill without an explicit apply writes nothing at all', () => {
  const vault = makeVault({ notes: { 'Legacy Note.md': LEGACY_NOTE } });
  const before = snapshot(vault.notesDir);
  const plan = planContentOriginBackfill({ notesDir: vault.notesDir });

  const dryRun = applyContentOriginBackfill({ plan });
  assert.equal(dryRun.mode, 'dry-run');
  assert.equal(dryRun.applied, false);
  assert.equal(dryRun.mutated, false);
  assert.equal(dryRun.proposalCount, 1);
  assert.equal(snapshot(vault.notesDir), before);

  assert.throws(
    () => applyContentOriginBackfill({ plan, apply: true }),
    /supported note writer/,
  );
  assert.equal(snapshot(vault.notesDir), before);
});

test('an applied backfill declares unknown through the supported writer and preserves the body bytes', () => {
  const vault = makeVault({ notes: { 'Legacy Note.md': LEGACY_NOTE } });
  const plan = planContentOriginBackfill({ notesDir: vault.notesDir, includePaths: true });
  const bodyBefore = bodyOf(fs.readFileSync(path.join(vault.notesDir, 'Legacy Note.md'), 'utf8'));

  const applied = withNotesEnv(vault, () => applyContentOriginBackfill({
    plan,
    apply: true,
    notesDir: vault.notesDir,
    writeNote: supportedNoteWriter(vault),
  }));

  assert.equal(applied.mode, 'apply');
  assert.equal(applied.aborted, false);
  assert.equal(applied.results.length, 1);
  assert.equal(applied.results[0].status, 'applied');
  assert.equal(applied.results[0].bodyPreserved, true);
  assert.equal(applied.results[0].bodyBytesIdentical, true);

  const after = fs.readFileSync(path.join(vault.notesDir, 'Legacy Note.md'), 'utf8');
  assert.match(after, /content_origin_schema: jarvos-content-origin\/v1/);
  assert.match(after, /content_origin: unknown/);
  assert.match(after, /human_evidence_eligible: false/);
  assert.match(after, /author: andrew/);
  assert.match(after, /A note that predates the contract\./);
  // Not "equivalent after trimming": the same bytes.
  assert.equal(bodyOf(after), bodyBefore);

  const audited = auditContentOrigin({ notesDir: vault.notesDir, journalDir: vault.journalDir });
  assert.equal(audited.notes.contract.declared_v1, 1);
  assert.equal(audited.notes.contract.legacy_author_only, 0);
  assert.equal(audited.notes.human_evidence_eligible, 0);
});

test('a dry run reports per-proposal eligibility without opening anything for writing', () => {
  const vault = makeVault({ notes: { 'Legacy Note.md': LEGACY_NOTE, 'No Heading.md': NO_HEADING_NOTE } });
  const before = snapshot(vault.notesDir);
  const plan = planContentOriginBackfill({ notesDir: vault.notesDir, includePaths: true });

  const dryRun = withNotesEnv(vault, () => applyContentOriginBackfill({ plan, notesDir: vault.notesDir }));

  assert.equal(dryRun.mode, 'dry-run');
  assert.equal(dryRun.mutated, false);
  assert.equal(dryRun.eligibleCount, 1);
  const byPath = Object.fromEntries(dryRun.results.map((result) => [result.relativePath, result]));
  assert.equal(byPath['Legacy Note.md'].status, 'eligible');
  // The canonical writer would insert a `# <title>` heading, so the body bytes
  // cannot be preserved and the note is refused rather than rewritten.
  assert.equal(byPath['No Heading.md'].status, 'skipped');
  assert.equal(byPath['No Heading.md'].reason, 'body_bytes_would_change');
  assert.equal(snapshot(vault.notesDir), before);
});

test('apply refuses a plan whose paths were withheld rather than guessing them', () => {
  const vault = makeVault({ notes: { 'Legacy Note.md': LEGACY_NOTE } });
  const before = snapshot(vault.notesDir);
  const plan = planContentOriginBackfill({ notesDir: vault.notesDir });

  const applied = withNotesEnv(vault, () => applyContentOriginBackfill({
    plan,
    apply: true,
    notesDir: vault.notesDir,
    writeNote: supportedNoteWriter(vault),
  }));

  assert.equal(applied.mutated, false);
  assert.equal(applied.results[0].status, 'skipped');
  assert.equal(applied.results[0].reason, 'plan_paths_withheld');
  assert.equal(snapshot(vault.notesDir), before);
});

test('apply rejects escaped, absolute, and symlinked proposal paths before touching anything', () => {
  const vault = makeVault({ notes: { 'Legacy Note.md': LEGACY_NOTE } });
  const outside = path.join(vault.root, 'Outside.md');
  fs.writeFileSync(outside, LEGACY_NOTE, 'utf8');
  fs.symlinkSync(outside, path.join(vault.notesDir, 'Linked Note.md'));
  const notesBefore = snapshot(vault.notesDir);
  const outsideBefore = fs.readFileSync(outside, 'utf8');

  const digest = crypto.createHash('sha256').update(LEGACY_NOTE, 'utf8').digest('hex');
  const proposal = (relativePath) => ({
    relativePath,
    title: 'Legacy Note',
    sourceDigest: digest,
    next: {
      content_origin_schema: 'jarvos-content-origin/v1',
      content_origin: 'unknown',
      content_origin_basis: 'unknown',
      human_evidence_eligible: false,
    },
  });

  const hostile = {
    proposals: [
      proposal('../Outside.md'),
      proposal('Projects/../../Outside.md'),
      proposal(outside),
      proposal('/etc/passwd.md'),
      proposal('..\\Outside.md'),
      proposal('Linked Note.md'),
    ],
  };

  const applied = withNotesEnv(vault, () => applyContentOriginBackfill({
    plan: hostile,
    apply: true,
    notesDir: vault.notesDir,
    writeNote: () => { throw new Error('the writer must never be reached for an unsafe path'); },
  }));

  assert.equal(applied.mutated, false);
  assert.deepEqual(applied.results.map((result) => result.status), Array(6).fill('skipped'));
  assert.deepEqual(applied.results.map((result) => result.reason), [
    'path_escape',
    'path_escape',
    'path_absolute',
    'path_absolute',
    'path_escape',
    'symlink',
  ]);
  assert.equal(snapshot(vault.notesDir), notesBefore);
  assert.equal(fs.readFileSync(outside, 'utf8'), outsideBefore);
});

test('apply refuses a stale or tampered proposal instead of writing a declaration from bytes that moved', () => {
  const vault = makeVault({ notes: { 'Legacy Note.md': LEGACY_NOTE } });
  const plan = planContentOriginBackfill({ notesDir: vault.notesDir, includePaths: true });

  // The note changes after the plan was produced.
  fs.writeFileSync(path.join(vault.notesDir, 'Legacy Note.md'), LEGACY_NOTE.replace('predates', 'still predates'), 'utf8');
  const before = snapshot(vault.notesDir);

  const stale = withNotesEnv(vault, () => applyContentOriginBackfill({
    plan,
    apply: true,
    notesDir: vault.notesDir,
    writeNote: () => { throw new Error('a stale proposal must never reach the writer'); },
  }));
  assert.equal(stale.results[0].status, 'skipped');
  assert.equal(stale.results[0].reason, 'stale_proposal');
  assert.equal(snapshot(vault.notesDir), before);

  // A proposal with no digest at all is unverifiable, not implicitly fresh.
  const unverifiable = { proposals: [{ relativePath: 'Legacy Note.md', title: 'Legacy Note' }] };
  const result = withNotesEnv(vault, () => applyContentOriginBackfill({
    plan: unverifiable,
    apply: true,
    notesDir: vault.notesDir,
    writeNote: () => { throw new Error('an unverifiable proposal must never reach the writer'); },
  }));
  assert.equal(result.results[0].reason, 'proposal_unverifiable');
  assert.equal(snapshot(vault.notesDir), before);
});

test('apply never smuggles a caller-supplied origin through the proposal', () => {
  const vault = makeVault({ notes: { 'Legacy Note.md': LEGACY_NOTE } });
  const plan = planContentOriginBackfill({ notesDir: vault.notesDir, includePaths: true });
  plan.proposals[0].next = {
    content_origin_schema: 'jarvos-content-origin/v1',
    content_origin: 'human',
    content_origin_basis: 'verbatim_user',
    human_evidence_eligible: true,
  };

  const seen = [];
  withNotesEnv(vault, () => applyContentOriginBackfill({
    plan,
    apply: true,
    notesDir: vault.notesDir,
    writeNote: (args) => {
      seen.push(args.frontmatter);
      return supportedNoteWriter(vault)(args);
    },
  }));

  assert.deepEqual(seen, [{
    content_origin_schema: 'jarvos-content-origin/v1',
    content_origin: 'unknown',
    content_origin_basis: 'unknown',
    human_evidence_eligible: false,
  }]);
  const after = fs.readFileSync(path.join(vault.notesDir, 'Legacy Note.md'), 'utf8');
  assert.match(after, /content_origin: unknown/);
  assert.doesNotMatch(after, /content_origin: human/);
});

// An unsupported writer that rewrites prose behind the contract's back, but
// honestly reports the binding: the guard it was given and the bytes it wrote.
function bodyChangingWriter(vault, badContentFor, { afterWrite } = {}) {
  return ({ title, expectedExistingContent }) => {
    const target = path.join(vault.notesDir, `${title}.md`);
    const bad = badContentFor(expectedExistingContent);
    fs.writeFileSync(target, bad, 'utf8');
    if (afterWrite) afterWrite(target);
    return {
      receipt: { status: 'committed' },
      stateBinding: { expectedHash: sha256Hex(expectedExistingContent), contentHash: sha256Hex(bad) },
    };
  };
}

test('a writer that changes the body stops the run and hands the pre-image to recovery', () => {
  const vault = makeVault({
    notes: { 'Legacy Note.md': LEGACY_NOTE, 'Undeclared Note.md': UNDECLARED_NOTE },
  });
  const plan = planContentOriginBackfill({ notesDir: vault.notesDir, includePaths: true });
  // Deterministic order so the misbehaving write happens first.
  plan.proposals.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  const legacyPath = path.join(vault.notesDir, 'Legacy Note.md');
  const before = fs.readFileSync(legacyPath, 'utf8');
  const undeclaredBefore = fs.readFileSync(path.join(vault.notesDir, 'Undeclared Note.md'), 'utf8');
  const bad = `${before}\nAn extra paragraph.\n`;

  const restores = [];
  const applied = withNotesEnv(vault, () => applyContentOriginBackfill({
    plan,
    apply: true,
    notesDir: vault.notesDir,
    writeNote: bodyChangingWriter(vault, () => bad),
    restoreNote: guardedRestore(restores),
  }));

  assert.equal(applied.aborted, true);
  assert.equal(applied.applied, false);
  assert.equal(applied.results[0].status, 'failed');
  assert.equal(applied.results[0].reason, 'body_changed_after_write');
  assert.equal(applied.results[0].rollbackAvailable, true);
  assert.equal(applied.results[0].rollbackAttempted, true);
  assert.equal(applied.results[0].rolledBack, true);
  assert.equal(restores.length, 1);
  // Guarded by the hash of the exact output this repair produced.
  assert.equal(restores[0].expectedHash, sha256Hex(bad));
  // The damaged note is back to its exact pre-edit bytes...
  assert.equal(fs.readFileSync(legacyPath, 'utf8'), before);
  // ...and the run did not go on to the next note.
  assert.equal(applied.results[1].status, 'skipped');
  assert.equal(applied.results[1].reason, 'aborted_after_integrity_violation');
  assert.equal(fs.readFileSync(path.join(vault.notesDir, 'Undeclared Note.md'), 'utf8'), undeclaredBefore);
});

test('a body-changing writer with no recovery seam is reported, not quietly accepted', () => {
  const vault = makeVault({ notes: { 'Legacy Note.md': LEGACY_NOTE } });
  const plan = planContentOriginBackfill({ notesDir: vault.notesDir, includePaths: true });
  const legacyPath = path.join(vault.notesDir, 'Legacy Note.md');
  const before = fs.readFileSync(legacyPath, 'utf8');

  const applied = withNotesEnv(vault, () => applyContentOriginBackfill({
    plan,
    apply: true,
    notesDir: vault.notesDir,
    writeNote: bodyChangingWriter(vault, () => `${before}\nAn extra paragraph.\n`),
  }));

  assert.equal(applied.applied, false);
  assert.equal(applied.mutated, true);
  assert.equal(applied.aborted, true);
  assert.equal(applied.results[0].status, 'failed');
  assert.equal(applied.results[0].reason, 'body_changed_after_write');
  assert.equal(applied.results[0].rollbackAvailable, false);
  assert.equal(applied.results[0].rolledBack, false);
});

// SUP-3959 (Astra P1): the preflight proved a replace against exact bytes, but
// the writer used to re-read the note and build a fresh guard. A change that
// landed in between was then overwritten and reported applied.
const CONCURRENT_DECLARATION = LEGACY_NOTE.replace('author: andrew\n', [
  'author: andrew',
  'content_origin_schema: jarvos-content-origin/v1',
  'content_origin: assistant',
  'content_origin_basis: assistant_generated',
  'human_evidence_eligible: false',
  '',
].join('\n'));
const CONCURRENT_BODY_EDIT = `${LEGACY_NOTE}Mobile prose added while the backfill ran.\n`;

for (const [label, concurrent] of [['declaration', CONCURRENT_DECLARATION], ['body', CONCURRENT_BODY_EDIT]]) {
  test(`a concurrent ${label} change after preflight is a conflict, never an overwrite`, () => {
    assert.notEqual(concurrent, LEGACY_NOTE);
    const vault = makeVault({ notes: { 'Legacy Note.md': LEGACY_NOTE } });
    const plan = planContentOriginBackfill({ notesDir: vault.notesDir, includePaths: true });
    const legacyPath = path.join(vault.notesDir, 'Legacy Note.md');

    const run = (writeNote) => {
      fs.writeFileSync(legacyPath, LEGACY_NOTE, 'utf8');
      const restores = [];
      const result = withNotesEnv(vault, () => applyContentOriginBackfill({
        plan,
        apply: true,
        notesDir: vault.notesDir,
        writeNote,
        restoreNote: guardedRestore(restores),
      }));
      return { result, restores };
    };

    // Between the preflight and the writer's own read.
    const early = run((args) => {
      fs.writeFileSync(legacyPath, concurrent, 'utf8');
      return supportedNoteWriter(vault)(args);
    });
    // Between the writer's read and the executor's commit.
    const guards = [];
    const late = run(supportedNoteWriter(vault, {
      beforeCommit: (operation) => {
        guards.push(operation.expectedHash);
        fs.writeFileSync(legacyPath, concurrent, 'utf8');
      },
    }));

    for (const { result, restores } of [early, late]) {
      assert.equal(result.applied, false);
      assert.equal(result.mutated, true);
      assert.equal(result.aborted, false);
      assert.equal(result.results[0].status, 'conflict');
      assert.equal(result.results[0].reason, 'changed_since_preflight');
      assert.equal(result.results[0].rollbackAttempted, false);
      assert.equal(restores.length, 0);
    }
    assert.equal(early.result.results[0].mutationStatus, undefined);
    assert.equal(late.result.results[0].mutationStatus, 'conflict');
    // The submitted guard was the preflight state, not a fresh read.
    assert.deepEqual(guards, [sha256Hex(LEGACY_NOTE)]);
    assert.equal(fs.readFileSync(legacyPath, 'utf8'), concurrent);
  });
}

// SUP-3959 (Astra P1): recovery used to hash whatever it observed last and
// restore the pre-image over it, which could erase a legitimate later edit.
test('an edit that lands after the repair commits is preserved, not restored away', () => {
  const vault = makeVault({ notes: { 'Legacy Note.md': LEGACY_NOTE, 'Undeclared Note.md': UNDECLARED_NOTE } });
  const plan = planContentOriginBackfill({ notesDir: vault.notesDir, includePaths: true });
  plan.proposals.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  const legacyPath = path.join(vault.notesDir, 'Legacy Note.md');
  const undeclaredBefore = fs.readFileSync(path.join(vault.notesDir, 'Undeclared Note.md'), 'utf8');
  const writer = supportedNoteWriter(vault);
  let edited;

  const restores = [];
  const applied = withNotesEnv(vault, () => applyContentOriginBackfill({
    plan,
    apply: true,
    notesDir: vault.notesDir,
    writeNote: (args) => {
      const written = writer(args);
      assert.equal(written.receipt.status, 'committed');
      edited = `${fs.readFileSync(legacyPath, 'utf8')}Mobile prose written right after the repair.\n`;
      fs.writeFileSync(legacyPath, edited, 'utf8');
      return written;
    },
    restoreNote: guardedRestore(restores),
  }));

  assert.equal(applied.results[0].status, 'conflict');
  assert.equal(applied.results[0].reason, 'changed_after_write');
  assert.equal(applied.results[0].mutationStatus, 'committed');
  assert.equal(applied.results[0].bodyPreserved, false);
  assert.equal(applied.results[0].rollbackAttempted, false);
  assert.equal(restores.length, 0);
  assert.equal(fs.readFileSync(legacyPath, 'utf8'), edited);
  // The moved body means this run cannot tell an editor from a bad writer.
  assert.equal(applied.aborted, true);
  assert.equal(applied.results[1].reason, 'aborted_after_integrity_violation');
  assert.equal(fs.readFileSync(path.join(vault.notesDir, 'Undeclared Note.md'), 'utf8'), undeclaredBefore);
});

test('a bad writer output that is edited again before the reread is not restored', () => {
  const vault = makeVault({ notes: { 'Legacy Note.md': LEGACY_NOTE } });
  const plan = planContentOriginBackfill({ notesDir: vault.notesDir, includePaths: true });
  const legacyPath = path.join(vault.notesDir, 'Legacy Note.md');
  const edited = `${LEGACY_NOTE}\nAn extra paragraph.\nAnd a human reply to it.\n`;

  const restores = [];
  const applied = withNotesEnv(vault, () => applyContentOriginBackfill({
    plan,
    apply: true,
    notesDir: vault.notesDir,
    writeNote: bodyChangingWriter(vault, (before) => `${before}\nAn extra paragraph.\n`, {
      afterWrite: (target) => fs.writeFileSync(target, edited, 'utf8'),
    }),
    restoreNote: guardedRestore(restores),
  }));

  assert.equal(applied.results[0].status, 'conflict');
  assert.equal(applied.results[0].reason, 'changed_after_write');
  assert.equal(applied.results[0].rollbackAttempted, false);
  assert.equal(restores.length, 0);
  assert.equal(fs.readFileSync(legacyPath, 'utf8'), edited);
  assert.equal(applied.aborted, true);
});

test('a writer that reports no expected-state binding is an integrity failure with no restore', () => {
  const vault = makeVault({ notes: { 'Legacy Note.md': LEGACY_NOTE, 'Undeclared Note.md': UNDECLARED_NOTE } });
  const plan = planContentOriginBackfill({ notesDir: vault.notesDir, includePaths: true });
  plan.proposals.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  const legacyPath = path.join(vault.notesDir, 'Legacy Note.md');
  const bad = `${LEGACY_NOTE}\nAn extra paragraph.\n`;

  const restores = [];
  const applied = withNotesEnv(vault, () => applyContentOriginBackfill({
    plan,
    apply: true,
    notesDir: vault.notesDir,
    writeNote: ({ title }) => {
      fs.writeFileSync(path.join(vault.notesDir, `${title}.md`), bad, 'utf8');
      return { receipt: { status: 'committed' } };
    },
    restoreNote: guardedRestore(restores),
  }));

  assert.equal(applied.results[0].status, 'failed');
  assert.equal(applied.results[0].reason, 'writer_did_not_bind_expected_state');
  assert.equal(applied.results[0].rollbackAttempted, false);
  assert.equal(restores.length, 0);
  assert.equal(fs.readFileSync(legacyPath, 'utf8'), bad);
  assert.equal(applied.aborted, true);
  assert.equal(applied.results[1].reason, 'aborted_after_integrity_violation');
});

test('a non-concurrent repair through the bound writer still commits with identical body bytes', () => {
  const vault = makeVault({ notes: { 'Legacy Note.md': LEGACY_NOTE } });
  const plan = planContentOriginBackfill({ notesDir: vault.notesDir, includePaths: true });
  const guards = [];
  const restores = [];

  const applied = withNotesEnv(vault, () => applyContentOriginBackfill({
    plan,
    apply: true,
    notesDir: vault.notesDir,
    writeNote: supportedNoteWriter(vault, { beforeCommit: (operation) => guards.push(operation) }),
    restoreNote: guardedRestore(restores),
  }));

  assert.equal(applied.results[0].status, 'applied');
  assert.equal(applied.results[0].bodyBytesIdentical, true);
  assert.equal(applied.aborted, false);
  assert.equal(restores.length, 0);
  assert.equal(guards.length, 1);
  assert.equal(guards[0].expectedHash, sha256Hex(LEGACY_NOTE));
  const after = fs.readFileSync(path.join(vault.notesDir, 'Legacy Note.md'), 'utf8');
  assert.equal(sha256Hex(after), sha256Hex(guards[0].content));
  assert.equal(bodyOf(after), bodyOf(LEGACY_NOTE));
});
