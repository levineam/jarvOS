'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  createFileWorkRunStatusReader,
  createFileWorkRunStore,
} = require('../src');

const PACKAGE_ENTRY = path.resolve(__dirname, '..', 'src', 'index.js');
const WORK_RUN_ID = 'run_sup3816';
const OUTCOME_ID = 'out_381600';
const FS_WRITE_METHODS = [
  'appendFileSync', 'chmodSync', 'copyFileSync', 'linkSync', 'mkdirSync', 'mkdtempSync', 'renameSync',
  'rmSync', 'rmdirSync', 'symlinkSync', 'truncateSync', 'unlinkSync', 'utimesSync', 'writeFileSync', 'writeSync',
];
const READ_ONLY_OPEN_FLAGS = new Set([undefined, 'r', 'rs', fs.constants.O_RDONLY]);

function withTempRoot(prefix, fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  try {
    return fn(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// Runs fn while any filesystem mutation (mkdir, open-for-write, write, rename, unlink, ...) is recorded and rejected.
function withoutFilesystemWrites(fn) {
  const calls = [];
  const originals = {};
  for (const name of [...FS_WRITE_METHODS, 'openSync']) originals[name] = fs[name];
  for (const name of FS_WRITE_METHODS) {
    fs[name] = () => {
      calls.push(name);
      throw new Error(`unexpected fs.${name} in status reader`);
    };
  }
  fs.openSync = (file, flags, ...rest) => {
    if (!READ_ONLY_OPEN_FLAGS.has(flags)) {
      calls.push(`openSync:${flags}`);
      throw new Error(`unexpected fs.openSync(${flags}) in status reader`);
    }
    return originals.openSync.call(fs, file, flags, ...rest);
  };
  let result;
  try {
    result = fn();
  } finally {
    Object.assign(fs, originals);
  }
  assert.deepEqual(calls, []);
  return result;
}

function snapshot(dir) {
  const entries = fs.readdirSync(dir).sort();
  const files = {};
  for (const name of entries) {
    const stat = fs.statSync(path.join(dir, name));
    files[name] = {
      bytes: stat.isFile() ? fs.readFileSync(path.join(dir, name)) : null,
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      ino: stat.ino,
    };
  }
  return { entries, mtimeMs: fs.statSync(dir).mtimeMs, files };
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

function populate(root) {
  const store = createFileWorkRunStore(root);
  const claim = claimed(store);
  const bound = store.bindFollowThrough({
    outcomeId: OUTCOME_ID,
    executorOwnerId: claim.ownerId,
    harnessWorkspaceId: 'workspace_sup3816',
    workRunId: claim.workRunId,
    todoId: 'bd_sup3816_next',
    triggerId: 'session_sup3816_resume',
    ownerId: claim.ownerId,
    fence: claim.fence,
  });
  assert.equal(bound.ok, true, JSON.stringify(bound));
  return store;
}

function storeReads(store) {
  return {
    publicRun: store.getWorkRun(WORK_RUN_ID),
    privateRun: store.getWorkRun(WORK_RUN_ID, { public: false }),
    followThrough: store.getFollowThrough(OUTCOME_ID),
    absent: store.getWorkRun('run_absent'),
  };
}

function readerReads(reader) {
  return {
    publicRun: reader.getWorkRun(WORK_RUN_ID),
    privateRun: reader.getWorkRun(WORK_RUN_ID, { public: false }),
    followThrough: reader.getFollowThrough(OUTCOME_ID),
    absent: reader.getWorkRun('run_absent'),
  };
}

test('status reader validates rootDir and returns null for a missing root without creating it', () => {
  assert.throws(() => createFileWorkRunStatusReader(''), /rootDir is required/);
  assert.throws(() => createFileWorkRunStatusReader(undefined), /rootDir is required/);

  withTempRoot('jarvos-status-reader-missing-', (parent) => {
    const missingRoot = path.join(parent, 'work-run-store');
    const before = snapshot(parent);

    const reads = withoutFilesystemWrites(() => readerReads(createFileWorkRunStatusReader(missingRoot)));

    assert.deepEqual(reads, { publicRun: null, privateRun: null, followThrough: null, absent: null });
    assert.equal(fs.existsSync(missingRoot), false);
    assert.deepEqual(snapshot(parent), before);
  });
});

test('status reader returns null for an existing root with no state file and leaves the root untouched', () => {
  withTempRoot('jarvos-status-reader-empty-', (root) => {
    const before = snapshot(root);
    assert.deepEqual(before.entries, []);

    const reads = withoutFilesystemWrites(() => readerReads(createFileWorkRunStatusReader(root)));

    assert.deepEqual(reads, { publicRun: null, privateRun: null, followThrough: null, absent: null });
    assert.deepEqual(snapshot(root), before);
  });
});

test('status reader exposes only reads and matches normal store public, private, and follow-through reads', () => {
  withTempRoot('jarvos-status-reader-parity-', (root) => {
    const store = populate(root);
    const expected = storeReads(store);
    assert.notEqual(expected.publicRun, null);
    assert.notEqual(expected.followThrough, null);

    const { reader, reads } = withoutFilesystemWrites(() => {
      const created = createFileWorkRunStatusReader(root);
      return { reader: created, reads: readerReads(created) };
    });

    assert.deepEqual(Object.keys(reader).sort(), ['getFollowThrough', 'getWorkRun']);
    assert.deepEqual(reads, expected);
    assert.equal(reads.absent, null);
    assert.equal(withoutFilesystemWrites(() => reader.getFollowThrough('out_999999')), null);
    assert.deepEqual(Object.keys(reads.publicRun), Object.keys(expected.publicRun));
    assert.doesNotMatch(JSON.stringify(reads.publicRun), /ownerId|canonicalWorktree|private\/jarvos/);
    assert.throws(() => reader.getWorkRun('../escape'), /workRunId must be an opaque identifier/);
    assert.throws(() => reader.getFollowThrough('__proto__'), /Projects outcome identifier/);
  });
});

test('repeated status reads preserve state bytes and an incumbent lock', () => {
  withTempRoot('jarvos-status-reader-repeat-', (root) => {
    let fd;
    try {
      const store = populate(root);
      const expected = storeReads(store);
      const { lockPath } = store.paths;
      fd = fs.openSync(lockPath, 'wx', 0o600);
      fs.writeFileSync(fd, `incumbent:${process.pid}`);
      const before = snapshot(root);
      assert.deepEqual(before.entries, ['work-runs.json', 'work-runs.lock']);

      const reads = withoutFilesystemWrites(() => {
        const reader = createFileWorkRunStatusReader(root);
        return [readerReads(reader), readerReads(reader), readerReads(reader)];
      });

      for (const read of reads) assert.deepEqual(read, expected);
      assert.deepEqual(snapshot(root), before);
      assert.equal(fs.readFileSync(lockPath, 'utf8'), `incumbent:${process.pid}`);
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
  });
});

test('corrupt or invalid state fails closed with the existing store errors and is not rewritten', () => {
  const fixtures = [
    { content: '{ not json', error: /^Error: corrupt work-run state: / },
    { content: JSON.stringify({ schemaVersion: 'wrong', revision: 0, workRuns: {} }), error: /^Error: invalid work-run state: / },
  ];
  for (const fixture of fixtures) {
    withTempRoot('jarvos-status-reader-corrupt-', (root) => {
      fs.writeFileSync(path.join(root, 'work-runs.json'), fixture.content);
      const before = snapshot(root);

      withoutFilesystemWrites(() => {
        const reader = createFileWorkRunStatusReader(root);
        assert.throws(() => reader.getWorkRun(WORK_RUN_ID), fixture.error);
        assert.throws(() => reader.getWorkRun(WORK_RUN_ID, { public: false }), fixture.error);
        assert.throws(() => reader.getFollowThrough(OUTCOME_ID), fixture.error);
      });

      assert.deepEqual(snapshot(root), before);
    });
  }
});

test('v1 state written before the follow-through index is read in memory without rewriting', () => {
  withTempRoot('jarvos-status-reader-v1-', (root) => {
    const store = createFileWorkRunStore(root);
    claimed(store);
    const statePath = store.paths.statePath;
    const legacy = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    delete legacy.followThrough;
    fs.writeFileSync(statePath, JSON.stringify(legacy, null, 2));
    const expected = storeReads(store);
    assert.equal(expected.followThrough, null);
    const before = snapshot(root);

    const reads = withoutFilesystemWrites(() => readerReads(createFileWorkRunStatusReader(root)));

    assert.deepEqual(reads, expected);
    assert.equal(reads.publicRun.workRunId, WORK_RUN_ID);
    assert.equal(reads.followThrough, null);
    assert.deepEqual(snapshot(root), before);
    assert.equal(Object.hasOwn(JSON.parse(fs.readFileSync(statePath, 'utf8')), 'followThrough'), false);
  });
});

test('a child process reads status from a read-only store root', (t) => {
  if (process.getuid && process.getuid() === 0) {
    t.skip('read-only directory permissions are not enforced for root');
    return;
  }
  withTempRoot('jarvos-status-reader-readonly-', (root) => {
    const expected = JSON.parse(JSON.stringify(storeReads(populate(root))));
    try {
      fs.chmodSync(root, 0o500);
      const before = snapshot(root);
      const script = `
        const { createFileWorkRunStatusReader } = require(process.argv[1]);
        const reader = createFileWorkRunStatusReader(process.argv[2]);
        process.stdout.write(JSON.stringify({
          publicRun: reader.getWorkRun(process.argv[3]),
          privateRun: reader.getWorkRun(process.argv[3], { public: false }),
          followThrough: reader.getFollowThrough(process.argv[4]),
          absent: reader.getWorkRun('run_absent'),
        }));
      `;
      const child = spawnSync(process.execPath, ['-e', script, PACKAGE_ENTRY, root, WORK_RUN_ID, OUTCOME_ID], { encoding: 'utf8' });

      assert.equal(child.status, 0, child.stderr);
      assert.deepEqual(JSON.parse(child.stdout), expected);
      assert.deepEqual(snapshot(root), before);
    } finally {
      fs.chmodSync(root, 0o700);
    }
  });
});
