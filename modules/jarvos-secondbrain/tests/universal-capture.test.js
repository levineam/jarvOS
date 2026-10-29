'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  EXIT_ERROR,
  EXIT_NOT_ACKNOWLEDGED,
  EXIT_NOT_CAPTURED,
  EXIT_OK,
  captureExitCode,
  captureFailureMessage,
  captureWithJarvos,
  frontmatterForCaptureEvent,
  main: captureMain,
  normalizeCaptureEvent,
} = require('../bridge/capture/src/universal-capture');
const { createAcknowledgedVaultMutationService } = require('./helpers/acknowledged-vault-mutation-service');
const { digestText } = require('../bridge/provenance/src/content-origin-contract');

const TEST_DATE = '2026-06-22';

function makeTempVault() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-universal-capture-'));
  const notesDir = path.join(root, 'Notes');
  const journalDir = path.join(root, 'Journal');
  const knowledgeDir = path.join(root, '.jarvos', 'knowledge');
  fs.mkdirSync(notesDir, { recursive: true });
  fs.mkdirSync(journalDir, { recursive: true });
  return { root, notesDir, journalDir, knowledgeDir };
}

function withVaultEnv(vault, fn) {
  const previous = {
    VAULT_NOTES_DIR: process.env.VAULT_NOTES_DIR,
    JARVOS_NOTES_DIR: process.env.JARVOS_NOTES_DIR,
    JOURNAL_DIR: process.env.JOURNAL_DIR,
    JARVOS_JOURNAL_DIR: process.env.JARVOS_JOURNAL_DIR,
    JARVOS_KNOWLEDGE_DIR: process.env.JARVOS_KNOWLEDGE_DIR,
    JARVOS_VAULT_DIR: process.env.JARVOS_VAULT_DIR,
  };
  process.env.VAULT_NOTES_DIR = vault.notesDir;
  process.env.JARVOS_NOTES_DIR = vault.notesDir;
  process.env.JOURNAL_DIR = vault.journalDir;
  process.env.JARVOS_JOURNAL_DIR = vault.journalDir;
  process.env.JARVOS_KNOWLEDGE_DIR = vault.knowledgeDir;
  process.env.JARVOS_VAULT_DIR = vault.root;
  try {
    return fn({ mutationService: createAcknowledgedVaultMutationService(vault.root), vaultRoot: vault.root, journalDir: vault.journalDir });
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function baseCapture(source, overrides = {}) {
  return {
    source,
    actor: { type: 'assistant', name: source },
    captureMode: 'prompted',
    privacyTier: 'local-private',
    origin: { kind: 'prompt', ref: `${source}:message-1` },
    evidence: [{ type: 'message', text: overrides.text || 'note: capture the universal contract', messageId: 'message-1' }],
    date: TEST_DATE,
    ...overrides,
  };
}

test('classifier-only high-confidence capture creates no note file or journal Notes backlink', () => {
  const vault = makeTempVault();
  try {
    withVaultEnv(vault, (options) => {
      const result = captureWithJarvos(baseCapture('openclaw', {
        title: 'Patch lifecycle isolation',
        text: 'The lifecycle test inherited the gateway stamp from its environment.',
        salienceClass: 'lesson',
        confidence: 0.99,
      }), options);

      assert.deepEqual(fs.readdirSync(vault.notesDir), [], 'no standalone note file');
      const journalPath = path.join(vault.journalDir, `${TEST_DATE}.md`);
      const journal = fs.existsSync(journalPath) ? fs.readFileSync(journalPath, 'utf8') : '';
      assert.doesNotMatch(journal, /\[\[Patch lifecycle isolation\]\]/, 'no Notes backlink');
      assert.equal(result.note, null);
      assert.equal(result.routing.plan.ignored, true);
    });
  } finally {
    fs.rmSync(vault.root, { recursive: true, force: true });
  }
});

test('quoted mid-text trigger phrases do not authorize a titled capture', () => {
  const vault = makeTempVault();
  try {
    withVaultEnv(vault, (options) => {
      const result = captureWithJarvos(baseCapture('openclaw', {
        title: 'Bounded patch instructions',
        text: 'Implement the router fix. Existing commands include "make a note" and "save this". Run the tests.',
        salienceClass: 'preference',
        confidence: 0.55,
      }), options);
      assert.deepEqual(fs.readdirSync(vault.notesDir), []);
      assert.deepEqual(fs.readdirSync(vault.journalDir), []);
      assert.equal(result.routing.plan.ignored, true);
    });
  } finally {
    fs.rmSync(vault.root, { recursive: true, force: true });
  }
});

test('compatibility captures carry explicit unknown provenance and enforcement rejects omissions', () => {
  const compatibility = normalizeCaptureEvent(baseCapture('codex', {
    text: 'note: compatibility provenance',
  }));
  assert.equal(compatibility.content_origin, 'unknown');
  assert.equal(compatibility.content_origin_basis, 'unknown');
  assert.equal(compatibility.human_evidence_eligible, false);

  assert.throws(
    () => normalizeCaptureEvent(baseCapture('codex', { text: 'note: enforced provenance' }), { requireDeclaration: true }),
    /content_origin declaration is required/,
  );
  for (const partial of [
    { content_origin: 'assistant' },
    { content_origin_basis: 'assistant_generated' },
    { user_source: { capture_event_id: 'capture-only' } },
  ]) {
    assert.throws(
      () => normalizeCaptureEvent(baseCapture('codex', { text: 'note: partial provenance', ...partial }), { requireDeclaration: true }),
      /content_origin declaration is required/,
    );
  }
  assert.throws(
    () => normalizeCaptureEvent(baseCapture('codex', {
      text: 'note: human without receipt',
      content_origin: 'human',
      content_origin_basis: 'verbatim_user',
    }), { requireDeclaration: true }),
    /valid user-source receipt/,
  );
});

test('declared provenance reaches note frontmatter while deferred adoption is stripped', () => {
  const event = normalizeCaptureEvent(baseCapture('codex', {
    title: 'Assistant-origin note',
    content: 'Generated copy that remains searchable context.',
    content_origin: 'assistant',
    content_origin_basis: 'assistant_generated',
    content_adoption: { state: 'accepted' },
  }));
  const frontmatter = frontmatterForCaptureEvent(event);

  assert.equal(frontmatter.content_origin, 'assistant');
  assert.equal(frontmatter.content_origin_basis, 'assistant_generated');
  assert.equal(frontmatter.human_evidence_eligible, false);
  assert.equal('content_adoption' in frontmatter, false);
});

test('receipt-bound human provenance survives the universal capture-to-note route', () => {
  const content = 'The user supplied this durable thought.';
  const captureEventId = 'capture-codex-human-1';
  const calls = [];
  const adapter = {
    ensureJournal() {
      return {
        existed: true,
        artifactReceipt: { artifacts: [{ kind: 'journal', vaultRelativePath: 'Journal/2026-06-22.md', outcome: 'committed' }] },
      };
    },
    appendLineToJournalSection(input) {
      return {
        ...input,
        artifactReceipt: { artifacts: [{ kind: 'journal', vaultRelativePath: 'Journal/2026-06-22.md', outcome: 'committed' }] },
      };
    },
    writeNote(input) {
      calls.push(input);
      return {
        written: true,
        title: input.title,
        path: `/tmp/${input.title}.md`,
        artifactReceipt: { artifacts: [{ kind: 'note', vaultRelativePath: 'Notes/User thought.md', outcome: 'committed' }] },
      };
    },
  };
  const result = captureWithJarvos({
    ...baseCapture('codex', {
      captureEventId,
      title: 'User thought',
      trigger: 'note',
      text: content,
      content_origin: 'human',
      content_origin_basis: 'verbatim_user',
      user_source: {
        capture_event_id: captureEventId,
        actor: 'user',
        source_digest: digestText(content),
        content_digest: digestText(content),
      },
    }),
  }, {
    adapter,
    resolveUserSource: (id) => id === captureEventId ? { capture_event_id: id, actor: 'user', text: content } : null,
  });

  assert.equal(result.ok, true);
  assert.equal(calls[0].frontmatter.content_origin, 'human');
  assert.equal(calls[0].frontmatter.content_origin_basis, 'verbatim_user');
  assert.equal(calls[0].frontmatter.human_evidence_eligible, true);
  assert.equal(calls[0].frontmatter.content_origin_source.capture_event_id, captureEventId);
});

test('capture drafting history reaches the canonical writer with served evidence only via the injected resolver', () => {
  const { frontmatterToObject, parseFrontmatter } = require('../packages/jarvos-secondbrain-notes/src/lib/note-schema');
  const served = { kind: 'assistant_draft', harness: 'codex', model: 'gpt-5-codex', model_evidence: 'served', served_ref: 'resp-cap-1' };
  const declared = { kind: 'assistant_edit', harness: 'claude-code', model: 'claude-opus-5-5', model_evidence: 'declared' };
  const resolveServedModel = (ref) => (ref === 'resp-cap-1' ? { model: 'gpt-5-codex' } : null);
  const frontmatter = { status: 'draft', type: 'reference', project: 'SUP-4054', author: 'jarvis' };
  const capture = (title, content_origin_drafting, extra = {}) => baseCapture('codex', {
    title,
    text: `note: ${title} drafted by an assistant for later retrieval.`,
    actor: { type: 'assistant', name: 'codex', model: 'actor-model-must-not-appear' },
    content_origin: 'assistant',
    content_origin_basis: 'assistant_generated',
    content_origin_drafting,
    frontmatter,
    ...extra,
  });
  const vault = makeTempVault();
  withVaultEnv(vault, (options) => {
    const result = captureWithJarvos(capture('Drafted capture', [served, declared]), { ...options, resolveServedModel });
    assert.equal(result.ok, true);
    const stored = frontmatterToObject(parseFrontmatter(fs.readFileSync(result.note.path, 'utf8')));
    assert.deepEqual(stored.content_origin_drafting, [served, declared]);
    assert.doesNotMatch(JSON.stringify(stored), /actor-model-must-not-appear/);

    // No resolver: the served claim is rejected rather than trusted.
    assert.throws(() => captureWithJarvos(capture('Unresolved capture', [served]), options), /served_unresolved/);

    // Harness-neutral capture with no declared model stays explicitly unknown.
    const unknown = captureWithJarvos(capture('Unknown capture', undefined), options);
    assert.equal(unknown.ok, true);
    const unknownStored = frontmatterToObject(parseFrontmatter(fs.readFileSync(unknown.note.path, 'utf8')));
    assert.deepEqual(unknownStored.content_origin_drafting, [{ kind: 'assistant_draft', harness: 'unknown', model: 'unknown', model_evidence: 'unknown' }]);
  });
});

test('normalizes supported and custom agents into CaptureEvent v2', () => {
  for (const source of ['codex', 'claude-code', 'openclaw', 'chatgpt', 'custom:future-agent']) {
    const event = normalizeCaptureEvent(baseCapture(source, {
      text: 'note: capture the universal contract',
    }));
    assert.equal(event.schemaVersion, '2.0');
    assert.equal(typeof event.source === 'string' ? event.source : event.source.tool, source);
    assert.equal(event.captureMode, 'prompted');
    assert.equal(event.privacyTier, 'local-private');
  }
});

test('explicit note capture writes canonical note journal backlink and sidecars for each agent path', () => {
  for (const source of ['codex', 'claude-code', 'openclaw', 'hermes', 'custom:future-agent']) {
    const vault = makeTempVault();
    withVaultEnv(vault, (options) => {
      const result = captureWithJarvos(baseCapture(source, {
        title: `${source} universal capture`,
        text: 'note: capture the universal note path with source-backed evidence.',
        frontmatter: {
          status: 'draft',
          type: 'reference',
          project: 'SUP-3233',
          author: 'jarvis',
        },
      }), options);

      assert.equal(result.ok, true);
      assert.equal(result.routing.plan.route, 'note');
      assert.ok(result.note.path.startsWith(vault.notesDir));
      assert.deepEqual(result.artifactReceipt.artifacts.map(({ kind, vaultRelativePath, outcome }) => ({ kind, vaultRelativePath, outcome })), [
        { kind: 'note', vaultRelativePath: `Notes/${result.note.title}.md`, outcome: 'committed' },
        { kind: 'journal', vaultRelativePath: `Journal/${TEST_DATE}.md`, outcome: 'committed' },
      ]);
      assert.equal(result.journalEntry.journalPath, path.join(vault.journalDir, `${TEST_DATE}.md`));
      assert.equal(fs.existsSync(path.join(vault.notesDir, `Daily Journal — ${TEST_DATE}.md`)), false);

      const journal = fs.readFileSync(result.journalEntry.journalPath, 'utf8');
      const backlink = `[[${result.note.title}]]`;
      assert.equal(journal.split(backlink).length - 1, 1);

      assert.equal(result.knowledge.qmdStatus, 'pending-refresh');
      assert.ok(fs.existsSync(result.knowledge.artifactPath));
      assert.ok(fs.existsSync(result.knowledge.qmdPendingPath));
      const artifact = JSON.parse(fs.readFileSync(result.knowledge.artifactPath, 'utf8'));
      assert.equal(artifact.knowledgeUnits.length > 0, true);
      assert.equal(artifact.qmd.status, 'pending-refresh');
    });
  }
});

test('idea capture keeps lightweight ideas in journal and promotes substantive ideas to notes', () => {
  const vault = makeTempVault();
  withVaultEnv(vault, (options) => {
    const lightweight = captureWithJarvos(baseCapture('codex', {
      text: 'idea: tiny dashboard polish',
    }), options);
    assert.equal(lightweight.routing.plan.route, 'idea');
    assert.equal(lightweight.note, null);

    const substantive = captureWithJarvos(baseCapture('codex', {
      title: 'Universal capture contract',
      text: 'idea: define one jarVOS capture contract because each agent should call the same entrypoint and retrieval should cite the same source-backed sidecars.',
      frontmatter: {
        status: 'draft',
        type: 'reference',
        project: 'SUP-3233',
        author: 'jarvis',
      },
    }), options);
    assert.equal(substantive.routing.plan.route, 'idea');
    assert.ok(substantive.note);
    assert.equal(substantive.note.title, 'Universal capture contract');

    const journal = fs.readFileSync(path.join(vault.journalDir, `${TEST_DATE}.md`), 'utf8');
    assert.match(journal, /## 💡 Ideas/);
    assert.equal(journal.split('[[Universal capture contract]]').length - 1, 1);
    assert.equal(substantive.knowledge.qmdStatus, 'pending-refresh');
  });
});

test('strict journal commands use the public hard-command route', () => {
  const vault = makeTempVault();
  withVaultEnv(vault, (options) => {
    const result = captureWithJarvos(baseCapture('openclaw', {
      text: 'Add to Journal: reviewed the capture bug: no model needed',
    }), options);

    assert.equal(result.ok, true);
    assert.equal(result.hardCommand.disposition, 'capture');
    assert.equal(result.hardCommand.command, 'add-to-journal');
    assert.equal(result.routing.plan.route, 'journal');
    assert.equal(result.routing.note, null);
    assert.equal(result.routing.noteLink.heading, '## 📓 Journal Entry');
    assert.equal(result.routing.noteLink.line, '- reviewed the capture bug: no model needed');
  });
});

test('bare strict commands return needs_input without writing', () => {
  const vault = makeTempVault();
  withVaultEnv(vault, (options) => {
    const result = captureWithJarvos(baseCapture('openclaw', {
      text: 'Idea:   ',
    }), options);

    assert.equal(result.ok, false);
    assert.equal(result.error, null);
    assert.equal(result.hardCommand.disposition, 'needs_input');
    assert.equal(result.routing.response, 'What idea should I capture?');
    assert.deepEqual(result.artifactReceipt.artifacts, []);
    assert.equal(fs.readdirSync(vault.notesDir).length, 0);
    assert.equal(fs.readdirSync(vault.journalDir).length, 0);
  });
});

test('triggerless title+content capture requires explicit intent for library callers', () => {
  const vault = makeTempVault();
  withVaultEnv(vault, (options) => {
    const result = captureWithJarvos(baseCapture('claude-code', {
      title: 'Plain Programmatic Entry',
      content: 'Durable body text without router keywords.',
      evidence: [{ type: 'message', text: 'Durable body text without router keywords.' }],
    }), options);

    assert.equal(result.ok, false);
    assert.equal(result.routing.plan.ignored, true);
    assert.equal(result.routing.plan.route, null);
    assert.equal(result.routing.plan.defaultedToNoteBias, false);
    assert.match(result.error, /no explicit trigger/);
    assert.equal(fs.readdirSync(vault.notesDir).length, 0);
    assert.equal(fs.readdirSync(vault.journalDir).length, 0);
  });
});

test('explicit capture CLI does not claim a disk write without Obsidian acknowledgement', () => {
  const vault = makeTempVault();
  const env = {
    ...process.env,
    VAULT_NOTES_DIR: vault.notesDir,
    JARVOS_NOTES_DIR: vault.notesDir,
    JOURNAL_DIR: vault.journalDir,
    JARVOS_JOURNAL_DIR: vault.journalDir,
    JARVOS_KNOWLEDGE_DIR: vault.knowledgeDir,
    JARVOS_VAULT_DIR: vault.root,
    XDG_STATE_HOME: path.join(vault.root, '.state'),
    OBSIDIAN_CLI: path.join(vault.root, 'missing-obsidian-cli'),
  };
  const result = spawnSync(process.execPath, [
    path.join(__dirname, '../scripts/jarvos-capture.js'),
  ], {
    env,
    input: JSON.stringify(baseCapture('claude-code', {
      title: 'Plain CLI Entry',
      trigger: 'note',
      content: 'Durable body text without router keywords.',
      evidence: [{ type: 'message', text: 'Durable body text without router keywords.' }],
    })),
    encoding: 'utf8',
  });

  // ok:false must be visible to the caller's shell, not only in the JSON.
  assert.equal(result.status, 3);
  assert.match(result.stderr, /^Capture not acknowledged: .*(?:note|journal) .*\.md: (?:failed|deferred)/);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.routing.plan.ignored, false);
  assert.equal(parsed.routing.plan.route, 'note');
  assert.equal(parsed.note.written, false);
  assert.notEqual(parsed.artifactReceipt.artifacts.find((artifact) => artifact.kind === 'note')?.outcome, 'committed');
  assert.equal(fs.readdirSync(vault.notesDir).filter((name) => name.endsWith('.md')).length, 0);
});
test('long raw Idea capture stays journal-only without note backlink or QMD artifact', () => {
  const vault = makeTempVault();
  withVaultEnv(vault, (options) => {
    const text = 'Idea: the end of "vibe economics". Concept is that economics up until now has basically been based on vibes, and the shift is that agents, markets, and measurement loops can finally make those vibes explicit enough to inspect.';
    const result = captureWithJarvos(baseCapture('codex', { text }), options);

    assert.equal(result.ok, true);
    assert.equal(result.routing.plan.route, 'idea');
    assert.equal(result.routing.plan.createNote, false);
    assert.equal(result.note, null);
    assert.equal(result.knowledge, null);
    assert.equal(fs.readdirSync(vault.notesDir).filter((name) => name.endsWith('.md')).length, 0);
    assert.equal(fs.existsSync(path.join(vault.knowledgeDir, 'qmd-refresh-pending.json')), false);

    const journal = fs.readFileSync(path.join(vault.journalDir, `${TEST_DATE}.md`), 'utf8');
    assert.match(journal, /## 💡 Ideas/);
    assert.match(journal, /vibe economics/);
    assert.doesNotMatch(journal, /\[\[/);
  });
});

test('explicit durable idea flag wins over substantive false', () => {
  const vault = makeTempVault();
  withVaultEnv(vault, (options) => {
    const result = captureWithJarvos(baseCapture('codex', {
      text: 'Idea: durable capture contract for future agents',
      substantive: false,
      createDurableNote: true,
    }), options);

    assert.equal(result.ok, true);
    assert.equal(result.routing.plan.route, 'idea');
    assert.equal(result.routing.plan.createNote, true);
    assert.ok(result.note);
    assert.equal(result.knowledge.qmdStatus, 'pending-refresh');
  });
});

async function runCaptureMain(input, capture) {
  const { Readable, Writable } = require('node:stream');
  const chunks = { stdout: '', stderr: '' };
  const sink = (name) => new Writable({ write(chunk, _encoding, done) { chunks[name] += chunk; done(); } });
  const exit = [];
  const code = await captureMain({ stdin: Readable.from([input]), stdout: sink('stdout'), stderr: sink('stderr'), capture, setExitCode: (value) => exit.push(value) });
  return { code, exit, ...chunks };
}

test('capture CLI exits non-zero whenever the result is not ok', async () => {
  assert.equal(EXIT_OK, 0);
  const acknowledged = { ok: true, routing: { plan: { ignored: false } }, artifactReceipt: { artifacts: [] } };
  const unacknowledged = {
    ok: false,
    routing: { plan: { ignored: false } },
    artifactReceipt: { artifacts: [{ kind: 'journal', vaultRelativePath: 'Journal/2026-10-28.md', outcome: 'deferred' }] },
    journalEntry: { receipt: { status: 'unknown_after_dispatch', adapterEvidence: { errorClass: 'dispatch_failed', errorMessage: 'cli timed out' } } },
  };

  const ok = await runCaptureMain('{}', () => acknowledged);
  assert.deepEqual([ok.code, ok.exit, ok.stderr], [EXIT_OK, [EXIT_OK], '']);
  assert.equal(JSON.parse(ok.stdout).ok, true);

  const bad = await runCaptureMain('{}', () => unacknowledged);
  assert.equal(bad.code, EXIT_NOT_ACKNOWLEDGED);
  assert.notEqual(bad.code, 0);
  assert.equal(JSON.parse(bad.stdout).ok, false, 'the JSON stays on stdout');
  assert.equal(bad.stderr, 'Capture not acknowledged: journal Journal/2026-10-28.md: deferred (dispatch_failed: cli timed out)\n');

  const ignored = await runCaptureMain('{}', () => ({ ok: false, routing: { plan: { ignored: true } }, error: 'Capture ignored: nothing to do' }));
  assert.deepEqual([ignored.code, ignored.stderr], [EXIT_NOT_CAPTURED, 'Capture ignored: nothing to do\n']);

  const needsInput = await runCaptureMain('{}', () => ({ ok: false, hardCommand: { disposition: 'needs_input' }, routing: { response: 'What note should I capture?', plan: null } }));
  assert.deepEqual([needsInput.code, needsInput.stderr], [EXIT_NOT_CAPTURED, 'What note should I capture?\n']);

  const thrown = await runCaptureMain('{not json', () => acknowledged);
  assert.equal(thrown.code, EXIT_ERROR);
  assert.match(thrown.stderr, /"error"/);
  assert.equal(thrown.stdout, '');
});

test('capture exit code and stderr message are derived from the result, not from a thrown error', () => {
  assert.equal(captureExitCode({ ok: true }), 0);
  assert.equal(captureExitCode({ ok: false }), EXIT_NOT_ACKNOWLEDGED);
  assert.equal(captureExitCode(undefined), EXIT_NOT_ACKNOWLEDGED);
  assert.equal(captureFailureMessage({ ok: true }), null);
  assert.equal(
    captureFailureMessage({ ok: false, artifactReceipt: { artifacts: [] }, journalEntry: { receipt: { adapterEvidence: { reason: 'prior_operation_blocked' } } } }),
    'Capture not acknowledged (prior_operation_blocked)',
  );
});
