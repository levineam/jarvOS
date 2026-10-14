'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  WORK_RUN_STORE_SCHEMA_VERSION,
  createFileWorkRunStatusReader,
  createFileWorkRunStore,
  createWorkRunStore,
} = require('../src');

const PACKAGE_ENTRY = path.resolve(__dirname, '..', 'src', 'index.js');
const WORK_RUN_ID = 'run_sup3816_tx';
const CONTENDER_RUN_ID = 'run_sup3816_contender';

function withTempRoot(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-work-run-tx-'));
  try {
    return fn(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function claimed(store) {
  const result = store.claimWorkRun({
    subjectKey: 'levineam/jarvOS:SUP-3816',
    canonicalWorktree: '/private/jarvos/worktrees/SUP-3816',
    workRunId: WORK_RUN_ID,
    ownerId: 'agent:codex',
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  return result;
}

function routeEvent(claim, operationNonce) {
  return {
    workRunId: claim.workRunId,
    ownerId: claim.ownerId,
    fence: claim.fence,
    type: 'route',
    operation: 'plan',
    status: 'started',
    operationNonce,
    detail: 'route selected',
  };
}

function persisted(store) {
  const bytes = fs.readFileSync(store.paths.statePath);
  return { bytes, revision: JSON.parse(bytes).revision };
}

function persistedEventIds(root, workRunId = WORK_RUN_ID) {
  const run = createFileWorkRunStatusReader(root).getWorkRun(workRunId, { public: false });
  return run ? run.events.map((event) => event.eventId) : [];
}

test('file appendEvent emits no evidence when the locked save fails', () => {
  withTempRoot((root) => {
    const appended = [];
    const store = createFileWorkRunStore(root, { evidencePort: { append: (input) => appended.push(input) } });
    const claim = claimed(store);
    const before = persisted(store);
    fs.mkdirSync(`${store.paths.statePath}.${process.pid}.tmp`);

    assert.throws(() => store.appendEvent(routeEvent(claim, 'nonce-save-fail-01')), { code: 'EISDIR' });

    const after = persisted(store);
    assert.deepEqual(after.bytes, before.bytes);
    assert.equal(after.revision, before.revision);
    assert.equal(fs.existsSync(store.paths.lockPath), false);
    assert.deepEqual(appended, []);
  });
});

test('file evidence is emitted after commit and lock release, and never on dedupe or refusal', () => {
  withTempRoot((root) => {
    const observed = [];
    let store;
    const evidencePort = {
      append(input) {
        observed.push({
          eventId: input.event.eventId,
          visible: persistedEventIds(root).includes(input.event.eventId),
          lockAbsent: !fs.existsSync(store.paths.lockPath),
        });
      },
    };
    store = createFileWorkRunStore(root, { evidencePort });
    const claim = claimed(store);
    const input = routeEvent(claim, 'nonce-commit-01');

    const result = store.appendEvent(input);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(observed, [{ eventId: result.event.eventId, visible: true, lockAbsent: true }]);

    const committed = persisted(store);
    const retry = store.appendEvent(input);
    assert.equal(retry.deduped, true, JSON.stringify(retry));
    const stale = store.appendEvent({ ...input, fence: claim.fence + 1, operationNonce: 'nonce-stale-01' });
    assert.equal(stale.reason, 'stale_fence', JSON.stringify(stale));

    assert.equal(observed.length, 1);
    const after = persisted(store);
    assert.equal(after.revision, committed.revision);
    assert.deepEqual(after.bytes, committed.bytes);
  });
});

test('a contender process is refused while the parent decides and commits under the lock', () => {
  withTempRoot((root) => {
    let armed = false;
    let child = null;
    const script = `
      const { createFileWorkRunStore } = require(process.argv[1]);
      let report;
      try {
        const result = createFileWorkRunStore(process.argv[2]).claimWorkRun({
          subjectKey: 'levineam/jarvOS:SUP-3817',
          workRunId: process.argv[3],
          ownerId: 'agent:contender',
        });
        report = { ok: result.ok === true, error: null };
      } catch (error) {
        report = { ok: false, error: error.message };
      }
      process.stdout.write(JSON.stringify(report));
    `;
    const clock = () => {
      if (armed) {
        armed = false;
        child = spawnSync(process.execPath, ['-e', script, PACKAGE_ENTRY, root, CONTENDER_RUN_ID], { encoding: 'utf8', timeout: 10000 });
      }
      return Date.now();
    };
    const store = createFileWorkRunStore(root, { clock });
    const claim = claimed(store);
    const before = persisted(store);

    armed = true;
    let result = null;
    let parentError = null;
    try {
      result = store.appendEvent(routeEvent(claim, 'nonce-locked-01'));
    } catch (error) {
      parentError = error;
    }
    armed = false;

    assert.notEqual(child, null, 'the armed clock should have spawned the contender');
    const childReport = `child status=${child.status} signal=${child.signal} error=${child.error && child.error.message} stdout=${child.stdout} stderr=${child.stderr}`;
    assert.equal(parentError, null, `parent mutation failed: ${parentError && parentError.message}; ${childReport}`);
    assert.equal(result.ok, true, `${JSON.stringify(result)}; ${childReport}`);
    assert.equal(child.status, 0, childReport);
    assert.deepEqual(JSON.parse(child.stdout), { ok: false, error: 'work-run store is busy' }, childReport);

    const reader = createFileWorkRunStatusReader(root);
    assert.equal(reader.getWorkRun(CONTENDER_RUN_ID), null);
    assert.deepEqual(persistedEventIds(root), [result.event.eventId]);
    assert.equal(persisted(store).revision, before.revision + 1);
    assert.equal(fs.existsSync(store.paths.lockPath), false);
  });
});

test('custom load/save backends emit evidence only after a successful save', () => {
  let snapshot = { schemaVersion: WORK_RUN_STORE_SCHEMA_VERSION, revision: 0, workRuns: {}, followThrough: {} };
  let failSave = false;
  const backend = {
    load: () => JSON.parse(JSON.stringify(snapshot)),
    save(next, expectedRevision) {
      if (failSave) throw new Error('backend save failed');
      if (snapshot.revision !== expectedRevision) throw new Error('concurrent work-run state mutation');
      snapshot = JSON.parse(JSON.stringify(next));
    },
  };
  const observed = [];
  const evidencePort = {
    append(input) {
      const run = snapshot.workRuns[input.workRunId];
      observed.push({ eventId: input.event.eventId, persisted: Boolean(run && run.events.some((event) => event.eventId === input.event.eventId)) });
    },
  };
  const store = createWorkRunStore({ backend, evidencePort });
  const claim = claimed(store);

  const beforeFailure = JSON.stringify(snapshot);
  failSave = true;
  assert.throws(() => store.appendEvent(routeEvent(claim, 'nonce-backend-fail-01')), /backend save failed/);
  failSave = false;
  assert.deepEqual(observed, []);
  assert.equal(JSON.stringify(snapshot), beforeFailure);

  const result = store.appendEvent(routeEvent(claim, 'nonce-backend-ok-01'));
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(observed, [{ eventId: result.event.eventId, persisted: true }]);
});

test('an evidence failure after commit surfaces to the caller without losing the durable event', () => {
  withTempRoot((root) => {
    const appended = [];
    const store = createFileWorkRunStore(root, {
      evidencePort: {
        append(input) {
          appended.push(input.event.eventId);
          throw new Error('evidence sink unavailable');
        },
      },
    });
    const claim = claimed(store);
    const input = routeEvent(claim, 'nonce-evidence-throws-01');

    assert.throws(() => store.appendEvent(input), /evidence sink unavailable/);
    assert.equal(appended.length, 1);
    assert.deepEqual(persistedEventIds(root), appended);

    // Not exactly-once delivery: the commit stands, the failed append is not
    // redelivered, and the same-nonce retry is a dedupe that emits nothing.
    const retry = store.appendEvent(input);
    assert.equal(retry.ok, true, JSON.stringify(retry));
    assert.equal(retry.deduped, true);
    assert.equal(retry.event.eventId, appended[0]);
    assert.equal(appended.length, 1);
  });
});
