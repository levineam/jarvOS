'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const test = require('node:test');

const {
  createEvidence,
  createFileStore,
  createMemoryStore,
} = require('../src/index.js');

test('memory store allocates monotonic fences per mutation key', () => {
  const store = createMemoryStore();
  assert.equal(store.allocateFence('machine-a:repo:1:cleanup'), 1);
  assert.equal(store.allocateFence('machine-a:repo:1:cleanup'), 2);
  assert.equal(store.allocateFence('machine-a:repo:2:cleanup'), 1);
});

test('store rejects stale evidence after a newer fence is acquired', () => {
  const store = createMemoryStore();
  const first = store.acquireLease({ key: 'resource:cleanup', holder: 'command-1', ttlMs: -1 });
  const second = store.acquireLease({ key: 'resource:cleanup', holder: 'command-2' });
  const evidence = createEvidence({
    commandId: 'command-1',
    managerId: 'workspace-manager',
    outcome: 'satisfied',
    data: { stale: true },
  });

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  const result = store.commitEvidence(first.lease, evidence);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'stale_fence');
});

test('file store writes canonical state and journal after interruption-safe updates', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-control-plane-store-'));
  try {
    const store = createFileStore(tmp);
    const lease = store.acquireLease({ key: 'resource:cleanup', holder: 'command-1' });
    assert.equal(lease.ok, true);

    const state = JSON.parse(fs.readFileSync(path.join(tmp, 'state.json'), 'utf8'));
    const journal = fs.readFileSync(path.join(tmp, 'journal.ndjson'), 'utf8').trim().split('\n');
    assert.equal(state.leases.length, 1);
    assert.equal(journal.length, 2);
    assert.match(journal[0], /fence\.allocate|lease\.acquire/);

    const reopened = createFileStore(tmp);
    const recovered = reopened.snapshot();
    assert.equal(recovered.leases.length, 1);
    assert.equal(recovered.leases[0].id, lease.lease.id);
    assert.equal(recovered.journal.length, 2);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('file store recovers from an orphaned stale lock', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-control-plane-stale-lock-'));
  try {
    const lockPath = path.join(tmp, 'state.lock');
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 999999999, createdAt: '2000-01-01T00:00:00.000Z' }));
    const staleAt = new Date(Date.now() - 1000);
    fs.utimesSync(lockPath, staleAt, staleAt);

    const result = createFileStore(tmp, { staleLockMs: 10, lockTimeoutMs: 1000 })
      .acquireLease({ key: 'recoverable-lock', holder: 'command-1' });

    assert.equal(result.ok, true);
    assert.equal(fs.existsSync(lockPath), false);
    assert.equal(fs.existsSync(`${lockPath}.recover`), false, 'recovery gate released');
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('file store recovers from a malformed stale lock', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-control-plane-malformed-lock-'));
  try {
    const lockPath = path.join(tmp, 'state.lock');
    fs.writeFileSync(lockPath, '{"pid":');
    const staleAt = new Date(Date.now() - 1000);
    fs.utimesSync(lockPath, staleAt, staleAt);

    const result = createFileStore(tmp, { staleLockMs: 10, lockTimeoutMs: 1000 })
      .acquireLease({ key: 'malformed-lock', holder: 'command-1' });

    assert.equal(result.ok, true);
    assert.equal(fs.existsSync(lockPath), false);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

// Recovery no longer moves lockPath aside, so the former "after takeover" window
// is now "after qualification, before removal": the point where the recoverer
// takes the recovery gate. A fresh owner installed there must survive.
test('stale-lock recovery never unlinks a fresh lock installed after qualification', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-control-plane-lock-race-'));
  const lockPath = path.join(tmp, 'state.lock');
  const gatePath = `${lockPath}.recover`;
  const originalOpen = fs.openSync;
  const originalUnlink = fs.unlinkSync;
  const originalNow = Date.now;
  // Scoped controlled clock: the lock deadline and stale age both read Date.now,
  // so time stays at `base` (before the 20ms deadline) until the fresh owner is
  // installed, regardless of how long staging fsync takes.
  const base = originalNow();
  let clock = base;
  try {
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 999999999, createdAt: '2000-01-01T00:00:00.000Z' }));
    const staleAt = new Date(base - 1000);
    fs.utimesSync(lockPath, staleAt, staleAt);
    let installedFreshLock = false;
    // Finite real-wall-clock bound: if a regression never reaches the
    // replacement hook, the frozen clock must not hold the deadline forever.
    Date.now = () => {
      if (!installedFreshLock && originalNow() - base > 5000) {
        throw new Error('fixture: replacement hook not reached within 5s of real time');
      }
      return clock;
    };
    fs.openSync = (target, ...args) => {
      if (target === gatePath && !installedFreshLock) {
        installedFreshLock = true;
        originalUnlink(lockPath);
        fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, token: 'fresh-owner' }), { flag: 'wx' });
        // Past the deadline: the next failed acquisition times out deterministically.
        clock = base + 21;
      }
      return originalOpen(target, ...args);
    };

    assert.throws(
      () => createFileStore(tmp, { staleLockMs: 10, lockTimeoutMs: 20 }).acquireLease({ key: 'race', holder: 'contender' }),
      /Timed out acquiring file store lock/
    );
    assert.equal(installedFreshLock, true);
    assert.equal(JSON.parse(fs.readFileSync(lockPath, 'utf8')).token, 'fresh-owner');
    assert.equal(fs.existsSync(gatePath), false, 'recovery gate released');
  } finally {
    Date.now = originalNow;
    fs.openSync = originalOpen;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('stale-lock recovery never takes over a fresh lock installed before takeover', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-control-plane-lock-pre-takeover-race-'));
  const lockPath = path.join(tmp, 'state.lock');
  const originalStat = fs.statSync;
  const originalNow = Date.now;
  // Scoped controlled clock (see previous test): held before the deadline until
  // the fresh owner is installed at the recoverer's first observation.
  const base = originalNow();
  let clock = base;
  try {
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 999999999, createdAt: '2000-01-01T00:00:00.000Z' }));
    const staleAt = new Date(base - 1000);
    fs.utimesSync(lockPath, staleAt, staleAt);
    let installedFreshLock = false;
    // Finite real-wall-clock bound (see previous test).
    Date.now = () => {
      if (!installedFreshLock && originalNow() - base > 5000) {
        throw new Error('fixture: replacement hook not reached within 5s of real time');
      }
      return clock;
    };
    fs.statSync = (target, ...args) => {
      if (target === lockPath && !installedFreshLock) {
        const staleStat = originalStat(target, ...args);
        fs.rmSync(lockPath, { force: true });
        fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, token: 'fresh-owner' }));
        installedFreshLock = true;
        // Past the deadline: the next failed acquisition times out deterministically.
        clock = base + 21;
        return staleStat;
      }
      return originalStat(target, ...args);
    };

    assert.throws(
      () => createFileStore(tmp, { staleLockMs: 10, lockTimeoutMs: 20 }).acquireLease({ key: 'race', holder: 'contender' }),
      /Timed out acquiring file store lock/
    );
    assert.equal(installedFreshLock, true);
    assert.equal(JSON.parse(fs.readFileSync(lockPath, 'utf8')).token, 'fresh-owner');
  } finally {
    Date.now = originalNow;
    fs.statSync = originalStat;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

const takeoverFiles = (dir) => fs.readdirSync(dir).filter((name) => name.includes('.takeover-'));
const stagingFiles = (dir) => fs.readdirSync(dir).filter((name) => name.includes('.stage-'));

test('stale-lock recovery never moves a known live owner\'s old lock', async () => {
  // Live owners: this process, a live child process, and pid 1 (EPERM for an
  // unprivileged caller, which still means alive).
  const sleeper = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
  const originalRename = fs.renameSync;
  try {
    for (const pid of [process.pid, sleeper.pid, 1]) {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-control-plane-live-owner-lock-'));
      const lockPath = path.join(tmp, 'state.lock');
      try {
        const content = JSON.stringify({ pid, token: `live-owner-${pid}`, createdAt: '2000-01-01T00:00:00.000Z' });
        fs.writeFileSync(lockPath, content);
        const staleAt = new Date(Date.now() - 1000);
        fs.utimesSync(lockPath, staleAt, staleAt);
        const before = fs.statSync(lockPath);
        let lockMoves = 0;
        fs.renameSync = (from, to) => { if (from === lockPath) lockMoves += 1; return originalRename(from, to); };
        try {
          assert.throws(
            () => createFileStore(tmp, { staleLockMs: 10, lockTimeoutMs: 50 }).snapshot(),
            /Timed out acquiring file store lock/
          );
        } finally { fs.renameSync = originalRename; }
        assert.equal(lockMoves, 0, `live owner ${pid}: lock was moved`);
        const after = fs.statSync(lockPath);
        assert.equal(after.dev, before.dev);
        assert.equal(after.ino, before.ino, `live owner ${pid}: lock inode replaced`);
        assert.equal(fs.readFileSync(lockPath, 'utf8'), content);
        assert.deepEqual(takeoverFiles(tmp), []);
      } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
    }
  } finally {
    fs.renameSync = originalRename;
    sleeper.kill();
  }
});

test('stale-lock recovery leaves fresh and partially written locks untouched', () => {
  const originalRename = fs.renameSync;
  // '{"released":true}' is no longer a recovery shortcut: it is ownerless content
  // and, like any malformed lock, recoverable only once stale.
  for (const content of ['', '{"pid":', JSON.stringify({ pid: 999999999, token: 'fresh-dead-pid' }), '{"released":true}']) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-control-plane-fresh-lock-'));
    const lockPath = path.join(tmp, 'state.lock');
    try {
      fs.writeFileSync(lockPath, content);
      const before = fs.statSync(lockPath);
      let lockMoves = 0;
      fs.renameSync = (from, to) => { if (from === lockPath) lockMoves += 1; return originalRename(from, to); };
      try {
        assert.throws(
          () => createFileStore(tmp, { staleLockMs: 60000, lockTimeoutMs: 50 }).snapshot(),
          (error) => /Timed out acquiring file store lock/.test(error.message) && error.code === 'FILE_STORE_LOCK_TIMEOUT'
            && !error.message.includes(tmp) && !error.message.includes('state.lock')
        );
      } finally { fs.renameSync = originalRename; }
      assert.equal(lockMoves, 0, `fresh lock ${JSON.stringify(content)} was moved`);
      assert.equal(fs.statSync(lockPath).ino, before.ino);
      assert.equal(fs.readFileSync(lockPath, 'utf8'), content);
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  }
});

const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// Replaces the former displaced-lock restore test: recovery no longer moves
// lockPath at all, so there is nothing to restore and no check-then-rename
// fallback. Hard links are made unsupported and a replacement is installed at
// whichever destructive step the recoverer reaches first; a contender installs
// a lock the moment lockPath is observed free. The replacement must stay intact.
// Acquisition itself now publishes by an atomic staging->lockPath hard link, so
// only that publication link is passed through (and counted separately); every
// other link call -- i.e. any use by recovery -- still fails ENOTSUP and is
// asserted absent.
test('stale-lock recovery never renames lockPath and leaves a concurrent replacement intact without hard links', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-control-plane-lock-no-link-'));
  const lockPath = path.join(tmp, 'state.lock');
  const gatePath = `${lockPath}.recover`;
  const originals = { openSync: fs.openSync, renameSync: fs.renameSync, linkSync: fs.linkSync, lstatSync: fs.lstatSync, statSync: fs.statSync, unlinkSync: fs.unlinkSync };
  const originalNow = Date.now;
  // Scoped controlled clock (see the fresh-lock race tests above): time stays at
  // `base` (before the 50ms deadline) until the replacement hook runs, so slow
  // staging/fsync/process checks cannot time out before recovery is reached.
  const base = originalNow();
  let clock = base;
  try {
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 999999999, createdAt: '2000-01-01T00:00:00.000Z' }));
    const staleAt = new Date(base - 1000);
    fs.utimesSync(lockPath, staleAt, staleAt);
    let replacementIno = null;
    let lockRenames = 0;
    let linkCalls = 0;
    let publicationLinks = 0;
    let competed = false;
    // Finite real-wall-clock bound: a regression that never reaches the
    // replacement hook must not hold the frozen deadline forever.
    Date.now = () => {
      if (replacementIno === null && originalNow() - base > 5000) {
        throw new Error('fixture: replacement hook not reached within 5s of real time');
      }
      return clock;
    };
    const replace = () => {
      if (replacementIno !== null) return;
      originals.unlinkSync(lockPath);
      fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, token: 'replacement-owner' }), { flag: 'wx' });
      replacementIno = originals.statSync(lockPath).ino;
      // Past the deadline: the next failed acquisition times out deterministically.
      clock = base + 51;
    };
    fs.openSync = (target, ...args) => { if (target === gatePath) replace(); return originals.openSync(target, ...args); };
    fs.renameSync = (from, to) => {
      if (from === lockPath || to === lockPath) { lockRenames += 1; if (from === lockPath) replace(); }
      return originals.renameSync(from, to);
    };
    fs.linkSync = (from, to) => {
      if (to === lockPath && path.dirname(from) === tmp && path.basename(from).startsWith('state.lock.stage-')) {
        publicationLinks += 1;
        return originals.linkSync(from, to);
      }
      linkCalls += 1; const error = new Error('hard links unsupported'); error.code = 'ENOTSUP'; throw error;
    };
    fs.lstatSync = (target, ...args) => {
      try { return originals.lstatSync(target, ...args); } catch (error) {
        if (target === lockPath && error.code === 'ENOENT' && replacementIno !== null && !competed) {
          competed = true;
          fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, token: 'competing-owner' }), { flag: 'wx' });
        }
        throw error;
      }
    };
    try {
      assert.throws(
        () => createFileStore(tmp, { staleLockMs: 10, lockTimeoutMs: 50 }).snapshot(),
        /Timed out acquiring file store lock/
      );
    } finally { Object.assign(fs, originals); Date.now = originalNow; }
    assert.notEqual(replacementIno, null, 'the replacement raced the recoverer');
    assert.equal(lockRenames, 0, 'recovery never renames lockPath');
    assert.equal(linkCalls, 0, 'recovery needs no hard-link primitive');
    assert.ok(publicationLinks >= 1, 'the contender attempted no-overwrite publication and was refused (EEXIST)');
    assert.deepEqual(stagingFiles(tmp), [], 'refused publications removed their own staging files');
    assert.equal(competed, false, 'lockPath was never observed free after the replacement');
    assert.equal(fs.statSync(lockPath).ino, replacementIno);
    assert.equal(JSON.parse(fs.readFileSync(lockPath, 'utf8')).token, 'replacement-owner');
    assert.deepEqual(takeoverFiles(tmp), []);
    assert.equal(fs.existsSync(gatePath), false, 'recovery gate released');
  } finally {
    Date.now = originalNow;
    Object.assign(fs, originals);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// Replaces the former "release marks the owned lock released" marker test: the
// marker let a contender treat a live owner's lock as released between the
// owner's identity check and its unlink, so the owner could then delete the
// contender's new lock. Behavior asserted instead: at the exact moment the owner
// is about to unlink, a contender (with staleLockMs far below the lock's age)
// cannot remove the owner's lock, so no newer lock exists for the owner to delete.
test('a releasing live owner\'s lock cannot be removed by a contender, so release never deletes a newer lock', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-control-plane-lock-release-race-'));
  const lockPath = path.join(tmp, 'state.lock');
  const originalUnlink = fs.unlinkSync;
  try {
    const contender = createFileStore(tmp, { staleLockMs: 10, lockTimeoutMs: 50 });
    let fired = false;
    let contenderError = null;
    let inodeAtRelease = null;
    let inodeAfterContender = null;
    let newerOwnerInstalled = false;
    fs.unlinkSync = (target) => {
      if (target === lockPath && !fired) {
        fired = true;
        inodeAtRelease = fs.statSync(lockPath).ino;
        pause(30); // the owner's lock is now older than the contender's staleLockMs
        try { contender.snapshot(); } catch (error) { contenderError = error; }
        try { inodeAfterContender = fs.statSync(lockPath).ino; } catch (error) { if (error.code !== 'ENOENT') throw error; }
        if (inodeAfterContender === null) {
          // The owner's lock was removed under it: a newer owner takes the path.
          fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, token: 'newer-owner' }), { flag: 'wx' });
          newerOwnerInstalled = true;
        }
      }
      return originalUnlink(target);
    };
    try { createFileStore(tmp).putRecord({ id: 'owner-record', type: 'request' }); } finally { fs.unlinkSync = originalUnlink; }
    assert.equal(fired, true);
    assert.match(String(contenderError && contenderError.message), /Timed out acquiring file store lock/);
    assert.equal(inodeAfterContender, inodeAtRelease, 'the live owner\'s lock stayed in place during its release');
    assert.equal(newerOwnerInstalled, false);
    assert.equal(fs.existsSync(lockPath), false, 'the owner removed only its own lock');
    assert.deepEqual(takeoverFiles(tmp), []);
    const records = createFileStore(tmp, { lockTimeoutMs: 1000 }).snapshot().records;
    assert.ok(records.some((record) => record.id === 'owner-record'));
  } finally {
    fs.unlinkSync = originalUnlink;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('a present recovery gate makes stale recovery refuse without touching the gate, the lock or store data', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-control-plane-lock-gate-held-'));
  const lockPath = path.join(tmp, 'state.lock');
  const gatePath = `${lockPath}.recover`;
  try {
    createFileStore(tmp).putRecord({ id: 'record-a', type: 'request' });
    const stateBefore = fs.readFileSync(path.join(tmp, 'state.json'));
    const journalBefore = fs.readFileSync(path.join(tmp, 'journal.ndjson'));
    const lockContent = JSON.stringify({ pid: 999999999, createdAt: '2000-01-01T00:00:00.000Z' });
    // A crashed recoverer's gate: dead pid and old, i.e. it looks repairable.
    const gateContent = JSON.stringify({ pid: 999999999, createdAt: '2000-01-01T00:00:00.000Z' });
    fs.writeFileSync(lockPath, lockContent);
    fs.writeFileSync(gatePath, gateContent);
    const staleAt = new Date(Date.now() - 1000);
    fs.utimesSync(lockPath, staleAt, staleAt);
    fs.utimesSync(gatePath, staleAt, staleAt);
    const lockBefore = fs.statSync(lockPath);
    const gateBefore = fs.statSync(gatePath);

    assert.throws(
      () => createFileStore(tmp, { staleLockMs: 10, lockTimeoutMs: 50 }).snapshot(),
      (error) => error.code === 'FILE_STORE_RECOVERY_GATE_HELD'
        && /Timed out acquiring file store lock/.test(error.message)
        && /recovery gate/.test(error.message)
        // No private path in public diagnostics.
        && !error.message.includes(tmp) && !error.message.includes('state.lock')
    );
    assert.deepEqual(stagingFiles(tmp), [], 'every acquisition attempt removed its own staging file');
    assert.equal(fs.statSync(gatePath).ino, gateBefore.ino, 'gate never removed or replaced');
    assert.equal(fs.readFileSync(gatePath, 'utf8'), gateContent);
    assert.equal(fs.statSync(lockPath).ino, lockBefore.ino, 'stale lock left for operator reconciliation');
    assert.equal(fs.readFileSync(lockPath, 'utf8'), lockContent);
    assert.deepEqual(fs.readFileSync(path.join(tmp, 'state.json')), stateBefore);
    assert.deepEqual(fs.readFileSync(path.join(tmp, 'journal.ndjson')), journalBefore);

    // Bounded availability: the gate blocks only stale recovery. Once the
    // operator reconciles the dead lock, normal acquisition proceeds and the
    // gate is still not touched.
    fs.unlinkSync(lockPath);
    const snapshot = createFileStore(tmp, { staleLockMs: 10, lockTimeoutMs: 1000 }).snapshot();
    assert.ok(snapshot.records.some((record) => record.id === 'record-a'));
    assert.equal(fs.statSync(gatePath).ino, gateBefore.ino);
    assert.equal(fs.readFileSync(gatePath, 'utf8'), gateContent);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

// Two real processes. The laggard (child) qualifies the same stale lock and is
// held at its first recovery-ownership/destructive step (taking the gate, or
// renaming lockPath in the previous protocol). The parent then recovers the
// stale lock, acquires, and stays inside its critical section while the laggard
// continues. The laggard must never move or remove the parent's live lock nor
// enter its own critical section while the parent's is active.
test('a lagging stale-lock recoverer never removes a newly acquired live owner\'s lock (two processes)', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-control-plane-lagging-recoverer-'));
  const root = path.join(tmp, 'store');
  const sync = path.join(tmp, 'sync');
  const lockPath = path.join(root, 'state.lock');
  const modulePath = path.resolve(__dirname, '../src/index.js');
  fs.mkdirSync(root); fs.mkdirSync(sync);
  fs.writeFileSync(lockPath, JSON.stringify({ pid: 999999999, createdAt: '2000-01-01T00:00:00.000Z' }));
  const staleAt = new Date(Date.now() - 1000);
  fs.utimesSync(lockPath, staleAt, staleAt);
  const script = [
    "const fs=require('fs');const path=require('path');",
    'const [modulePath,root,sync]=process.argv.slice(1);',
    "const lockPath=path.join(root,'state.lock');const gatePath=lockPath+'.recover';",
    'const pause=(ms)=>Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,ms);',
    'let paused=false,lockRenames=0,foreignUnlinks=0,acquired=false,overlap=false;',
    "const barrier=()=>{paused=true;fs.writeFileSync(path.join(sync,'b-qualified'),'1');const d=Date.now()+10000;",
    "while(!fs.existsSync(path.join(sync,'go'))){if(Date.now()>d)throw new Error('no go');pause(5);}};",
    "const step=(fn)=>{barrier();try{return fn();}finally{fs.writeFileSync(path.join(sync,'b-continued'),'1');}};",
    'const o={openSync:fs.openSync,renameSync:fs.renameSync,unlinkSync:fs.unlinkSync};',
    'fs.openSync=function(p,...r){if(p===gatePath&&!paused)return step(()=>o.openSync.call(fs,p,...r));return o.openSync.call(fs,p,...r);};',
    'fs.renameSync=function(a,b){if(a===lockPath||b===lockPath){lockRenames+=1;if(a===lockPath&&!paused)return step(()=>o.renameSync.call(fs,a,b));}return o.renameSync.call(fs,a,b);};',
    'fs.unlinkSync=function(p){if(p===lockPath&&!acquired)foreignUnlinks+=1;return o.unlinkSync.call(fs,p);};',
    'const {createFileStore}=require(modulePath);',
    "const store=createFileStore(root,{staleLockMs:10,lockTimeoutMs:15000,now:()=>{acquired=true;if(fs.existsSync(path.join(sync,'a-inside')))overlap=true;return new Date().toISOString();}});",
    "store.putRecord({id:'b-record',type:'request'});",
    'process.stdout.write(JSON.stringify({paused,lockRenames,foreignUnlinks,overlap}));',
  ].join('');
  const child = spawn(process.execPath, ['-e', script, modulePath, root, sync], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const exited = new Promise((resolve) => child.on('close', (code) => resolve(code)));
  try {
    const deadline = Date.now() + 15000;
    while (!fs.existsSync(path.join(sync, 'b-qualified'))) {
      if (child.exitCode !== null || Date.now() > deadline) throw new Error(`laggard never qualified the stale lock: ${stderr}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    let ownerHeld = false;
    let ownerIno = null;
    let displaced = false;
    let laggardContinuedDuringHold = false;
    const checkOwnerLock = () => {
      try { if (fs.statSync(lockPath).ino !== ownerIno) displaced = true; } catch (error) { if (error.code !== 'ENOENT') throw error; displaced = true; }
    };
    const owner = createFileStore(root, { staleLockMs: 10, lockTimeoutMs: 15000, now: () => {
      if (!ownerHeld) {
        ownerHeld = true;
        ownerIno = fs.statSync(lockPath).ino;
        fs.writeFileSync(path.join(sync, 'a-inside'), '1');
        fs.writeFileSync(path.join(sync, 'go'), '1');
        const until = Date.now() + 5000;
        while (!fs.existsSync(path.join(sync, 'b-continued')) && Date.now() < until) { checkOwnerLock(); pause(2); }
        laggardContinuedDuringHold = fs.existsSync(path.join(sync, 'b-continued'));
        const holdUntil = Date.now() + 400; // laggard keeps retrying meanwhile
        while (Date.now() < holdUntil) { checkOwnerLock(); pause(2); }
        checkOwnerLock();
        fs.rmSync(path.join(sync, 'a-inside'));
      }
      return new Date().toISOString();
    } });
    owner.putRecord({ id: 'a-record', type: 'request' });

    assert.equal(ownerHeld, true);
    assert.equal(laggardContinuedDuringHold, true, 'the laggard acted while the new owner was live');
    assert.equal(await exited, 0, stderr);
    const laggard = JSON.parse(stdout);
    assert.equal(laggard.paused, true);
    assert.equal(laggard.lockRenames, 0, 'the laggard never moved lockPath');
    assert.equal(laggard.foreignUnlinks, 0, 'the laggard never removed a lock it did not own');
    assert.equal(laggard.overlap, false, 'no second active critical section');
    assert.equal(displaced, false, 'the live owner\'s lock stayed in place for its whole critical section');
    assert.equal(fs.existsSync(lockPath), false);
    assert.equal(fs.existsSync(`${lockPath}.recover`), false);
    assert.deepEqual(takeoverFiles(root), []);
    const ids = createFileStore(root, { lockTimeoutMs: 1000 }).snapshot().records.map((record) => record.id).sort();
    assert.deepEqual(ids, ['a-record', 'b-record']);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('a live owner in another process keeps its lock past staleLockMs; its release is not resurrected', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-control-plane-live-process-lock-'));
  const root = path.join(tmp, 'store');
  const heldPath = path.join(tmp, 'held');
  const lockPath = path.join(root, 'state.lock');
  const modulePath = path.resolve(__dirname, '../src/index.js');
  // The child holds the real store lock inside a real mutation (via the public
  // `now` option) for holdMs, far beyond the contender's staleLockMs.
  const script = `const fs=require('fs');const {createFileStore}=require(process.argv[1]);let held=false;`
    + `const store=createFileStore(process.argv[2],{now:()=>{if(!held){held=true;fs.writeFileSync(process.argv[3],String(process.pid));`
    + `Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,Number(process.argv[4]));}return new Date().toISOString();}});`
    + `store.putRecord({id:'child-record',type:'request'});`;
  const originalRename = fs.renameSync;
  const child = spawn(process.execPath, ['-e', script, modulePath, root, heldPath, '1000'], { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const exited = new Promise((resolve) => child.on('close', (code) => resolve(code)));
  try {
    const deadline = Date.now() + 15000;
    while (!fs.existsSync(heldPath)) {
      if (child.exitCode !== null || Date.now() > deadline) throw new Error(`child never held the lock: ${stderr}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(JSON.parse(fs.readFileSync(lockPath, 'utf8')).pid, child.pid, 'child owns the real lock');

    let lockMoves = 0;
    fs.renameSync = (from, to) => { if (from === lockPath) lockMoves += 1; return originalRename(from, to); };
    try {
      createFileStore(root, { staleLockMs: 10, lockTimeoutMs: 15000 }).putRecord({ id: 'parent-record', type: 'request' });
    } finally { fs.renameSync = originalRename; }

    assert.equal(lockMoves, 0, 'the live owner\'s lock was never moved');
    assert.equal(await exited, 0, stderr);
    assert.equal(fs.existsSync(lockPath), false, 'released lock was not resurrected');
    assert.deepEqual(takeoverFiles(root), []);
    const ids = createFileStore(root, { lockTimeoutMs: 1000 }).snapshot().records.map((record) => record.id).sort();
    assert.deepEqual(ids, ['child-record', 'parent-record']);
  } finally {
    fs.renameSync = originalRename;
    if (child.exitCode === null && child.signalCode === null) child.kill();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// Two real processes. The writer (child) is held at an explicit file barrier
// while preparing its owner record -- inside its own write of that record --
// for far longer than staleLockMs. The parent then uses the same store with
// staleLockMs 10. Under the former protocol an empty lockPath existed during that
// gap, the parent removed it as stale-malformed, and the resumed writer entered
// through its unlinked inode while the parent was inside. Now the writer must
// either be refused publication by the parent's live lock and wait, or enter
// only while lockPath names its own owner record; never alongside the parent.
test('a writer paused while preparing its owner record past staleLockMs never enters without owning the lock (two processes)', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-control-plane-paused-writer-'));
  const root = path.join(tmp, 'store');
  const sync = path.join(tmp, 'sync');
  const lockPath = path.join(root, 'state.lock');
  const modulePath = path.resolve(__dirname, '../src/index.js');
  fs.mkdirSync(root); fs.mkdirSync(sync);
  const flag = (name) => fs.writeFileSync(path.join(sync, name), '1');
  const has = (name) => fs.existsSync(path.join(sync, name));
  const script = [
    "const fs=require('fs');const path=require('path');",
    'const [modulePath,root,sync]=process.argv.slice(1);',
    "const lockPath=path.join(root,'state.lock');",
    'const pause=(ms)=>Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,ms);',
    "const flag=(n)=>fs.writeFileSync(path.join(sync,n),'1');const has=(n)=>fs.existsSync(path.join(sync,n));",
    'let paused=false,entered=false,overlap=false,ownedAtEntry=null;',
    'const o={writeFileSync:fs.writeFileSync,linkSync:fs.linkSync};',
    // Test-side instrumentation: recognise this process's own owner record by content.
    "const ownRecord=(fd,data)=>{if(typeof fd!=='number'||typeof data!=='string')return false;try{const r=JSON.parse(data);return Boolean(r)&&r.pid===process.pid&&typeof r.token==='string';}catch(_){return false;}};",
    "fs.writeFileSync=function(fd,data,...r){if(!paused&&ownRecord(fd,data)){paused=true;flag('w-paused');const d=Date.now()+10000;while(!has('go')){if(Date.now()>d)throw new Error('no go');pause(5);}flag('w-resumed');}return o.writeFileSync.call(fs,fd,data,...r);};",
    "fs.linkSync=function(a,b){try{return o.linkSync.call(fs,a,b);}catch(e){if(b===lockPath&&e.code==='EEXIST')flag('w-blocked');throw e;}};",
    'const {createFileStore}=require(modulePath);',
    "const store=createFileStore(root,{staleLockMs:10,lockTimeoutMs:15000,now:()=>{if(has('p-inside'))overlap=true;",
    "if(!entered){entered=true;let pid=null;try{pid=JSON.parse(fs.readFileSync(lockPath,'utf8')).pid;}catch(_){pid=null;}ownedAtEntry=pid===process.pid;flag('w-entered');}",
    'return new Date().toISOString();}});',
    "store.putRecord({id:'w-record',type:'request'});",
    'process.stdout.write(JSON.stringify({paused,overlap,ownedAtEntry}));',
  ].join('');
  const child = spawn(process.execPath, ['-e', script, modulePath, root, sync], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const exited = new Promise((resolve) => child.on('close', (code) => resolve(code)));
  try {
    const deadline = Date.now() + 15000;
    while (!has('w-paused')) {
      if (child.exitCode !== null || Date.now() > deadline) throw new Error(`writer never reached its owner record: ${stderr}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    // The writer is held by the barrier (not by timing); let its state age far
    // past the parent's staleLockMs.
    await new Promise((resolve) => setTimeout(resolve, 200));
    let incompleteDuringPause = false;
    try {
      const text = fs.readFileSync(lockPath, 'utf8');
      try { const owner = JSON.parse(text); incompleteDuringPause = !(owner && owner.pid === child.pid && owner.token); } catch (_) { incompleteDuringPause = true; }
    } catch (error) { if (error.code !== 'ENOENT') throw error; }

    let parentHeld = false;
    let parentOwnerPid = null;
    let parentIno = null;
    let displaced = false;
    let writerOutcome = null;
    const checkParentLock = () => {
      try { if (fs.statSync(lockPath).ino !== parentIno) displaced = true; } catch (error) { if (error.code !== 'ENOENT') throw error; displaced = true; }
    };
    const parent = createFileStore(root, { staleLockMs: 10, lockTimeoutMs: 15000, now: () => {
      if (!parentHeld) {
        parentHeld = true;
        parentIno = fs.statSync(lockPath).ino;
        parentOwnerPid = JSON.parse(fs.readFileSync(lockPath, 'utf8')).pid;
        flag('p-inside');
        flag('go');
        const until = Date.now() + 10000;
        while (!has('w-entered') && !has('w-blocked') && Date.now() < until) { checkParentLock(); pause(2); }
        writerOutcome = has('w-entered') ? 'entered' : (has('w-blocked') ? 'blocked' : 'none');
        // Stay live while the resumed writer keeps retrying stale recovery
        // with staleLockMs 10 against this (complete, live) published lock.
        const holdUntil = Date.now() + 300;
        while (Date.now() < holdUntil) { checkParentLock(); pause(2); }
        checkParentLock();
        fs.rmSync(path.join(sync, 'p-inside'));
      }
      return new Date().toISOString();
    } });
    parent.putRecord({ id: 'p-record', type: 'request' });

    assert.equal(parentHeld, true);
    assert.equal(parentOwnerPid, process.pid, 'the parent owned the real lock inside its critical section');
    assert.equal(writerOutcome, 'blocked', 'the resumed writer was refused publication by the live owner instead of entering');
    assert.equal(displaced, false, 'the live published owner was never displaced');
    assert.equal(incompleteDuringPause, false, 'lockPath never exposed an incomplete owner record while the writer was paused');
    assert.equal(await exited, 0, stderr);
    const writer = JSON.parse(stdout);
    assert.equal(writer.paused, true);
    assert.equal(writer.overlap, false, 'no second active critical section');
    assert.equal(writer.ownedAtEntry, true, 'the writer entered only while lockPath named its own owner record');
    assert.equal(fs.existsSync(lockPath), false);
    assert.equal(fs.existsSync(`${lockPath}.recover`), false);
    assert.deepEqual(stagingFiles(root), []);
    const ids = createFileStore(root, { lockTimeoutMs: 1000 }).snapshot().records.map((record) => record.id).sort();
    assert.deepEqual(ids, ['p-record', 'w-record']);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// Every time lockPath is observable during acquisition, critical section and
// release (after each fs primitive the store invokes), it holds a complete,
// parseable owner record, and nothing ever writes to the published inode.
test('lockPath only ever exposes complete owner metadata, published atomically', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-control-plane-lock-publication-'));
  const lockPath = path.join(tmp, 'state.lock');
  const names = ['openSync', 'linkSync', 'writeFileSync', 'writeSync', 'fsyncSync', 'ftruncateSync', 'closeSync', 'unlinkSync', 'renameSync'];
  const originals = Object.fromEntries(names.map((name) => [name, fs[name]]));
  const raw = { readFileSync: fs.readFileSync, statSync: fs.statSync, fstatSync: fs.fstatSync };
  const bad = [];
  let observedPresent = 0;
  let checking = false;
  const observe = (where) => {
    if (checking) return;
    checking = true;
    try {
      let text;
      try { text = raw.readFileSync(lockPath, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
      observedPresent += 1;
      let owner = null;
      try { owner = JSON.parse(text); } catch (_) { owner = null; }
      if (!owner || owner.pid !== process.pid || typeof owner.token !== 'string' || !owner.createdAt) bad.push(`${where}: ${JSON.stringify(text)}`);
    } finally { checking = false; }
  };
  const writesPublishedLock = (fd) => {
    if (checking || typeof fd !== 'number') return false;
    checking = true;
    try {
      const target = raw.fstatSync(fd);
      const published = raw.statSync(lockPath);
      return target.dev === published.dev && target.ino === published.ino;
    } catch (_) { return false; } finally { checking = false; }
  };
  try {
    for (const name of names) {
      fs[name] = function wrapped(...args) {
        if (['writeFileSync', 'writeSync', 'ftruncateSync'].includes(name) && writesPublishedLock(args[0])) bad.push(`${name} wrote the published lock inode`);
        observe(`before ${name}`);
        const result = originals[name].apply(fs, args);
        observe(`after ${name}`);
        return result;
      };
    }
    const store = createFileStore(tmp, { now: () => { observe('critical section'); return new Date().toISOString(); } });
    store.putRecord({ id: 'record-a', type: 'request' });
    store.putRecord({ id: 'record-b', type: 'request' });
    store.snapshot();
  } finally { Object.assign(fs, originals); }
  try {
    assert.deepEqual(bad, []);
    assert.ok(observedPresent > 0, 'lockPath was observed while held');
    assert.equal(fs.existsSync(lockPath), false);
    assert.deepEqual(stagingFiles(tmp), []);
    assert.deepEqual(createFileStore(tmp).snapshot().records.map((record) => record.id).sort(), ['record-a', 'record-b']);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('an unsupported hard-link publication primitive fails closed without overwrite, mutation, fallback or path disclosure', () => {
  const originalLink = fs.linkSync;
  for (const code of ['ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EPERM', 'EXDEV']) {
    for (const concurrent of [false, true]) {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-control-plane-lock-unsupported-'));
      const lockPath = path.join(tmp, 'state.lock');
      try {
        createFileStore(tmp).putRecord({ id: 'record-a', type: 'request' });
        const stateBefore = fs.readFileSync(path.join(tmp, 'state.json'));
        const journalBefore = fs.readFileSync(path.join(tmp, 'journal.ndjson'));
        const concurrentContent = JSON.stringify({ pid: process.pid, token: 'concurrent-owner' });
        let linkCalls = 0;
        let concurrentIno = null;
        let criticalSections = 0;
        fs.linkSync = (from, to) => {
          linkCalls += 1;
          if (concurrent && concurrentIno === null) {
            // Another party creates the target at the publication instant.
            fs.writeFileSync(lockPath, concurrentContent, { flag: 'wx' });
            concurrentIno = fs.statSync(lockPath).ino;
          }
          const error = new Error(`simulated ${code}: link '${from}' -> '${to}'`);
          error.code = code;
          throw error;
        };
        try {
          assert.throws(
            () => createFileStore(tmp, { staleLockMs: 10, lockTimeoutMs: 1000, now: () => { criticalSections += 1; return new Date().toISOString(); } })
              .putRecord({ id: 'record-b', type: 'request' }),
            (error) => error.code === 'FILE_STORE_LOCK_PUBLICATION_UNSUPPORTED'
              && !error.message.includes(tmp) && !error.message.includes('state.lock') && !error.message.includes('simulated')
              && error.cause === undefined
          );
        } finally { fs.linkSync = originalLink; }
        assert.equal(linkCalls, 1, `${code}: no retry and no check-then-rename fallback`);
        assert.equal(criticalSections, 0, `${code}: critical section never ran`);
        if (concurrent) {
          assert.equal(fs.statSync(lockPath).ino, concurrentIno, `${code}: concurrent target preserved`);
          assert.equal(fs.readFileSync(lockPath, 'utf8'), concurrentContent);
          fs.unlinkSync(lockPath); // operator/owner reconciliation for the follow-up read
        } else {
          assert.equal(fs.existsSync(lockPath), false, `${code}: nothing published`);
        }
        assert.deepEqual(stagingFiles(tmp), [], `${code}: own staging file removed`);
        assert.equal(fs.existsSync(`${lockPath}.recover`), false);
        assert.deepEqual(fs.readFileSync(path.join(tmp, 'state.json')), stateBefore);
        assert.deepEqual(fs.readFileSync(path.join(tmp, 'journal.ndjson')), journalBefore);
        assert.deepEqual(createFileStore(tmp).snapshot().records.map((record) => record.id), ['record-a']);
      } finally {
        fs.linkSync = originalLink;
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    }
  }
});

test('file store serializes leases across independent processes', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-control-plane-process-store-'));
  const modulePath = path.resolve(__dirname, '../src/index.js');
  const script = `const {createFileStore}=require(process.argv[1]); const r=createFileStore(process.argv[2]).acquireLease({key:'shared',holder:process.argv[3]}); process.stdout.write(JSON.stringify(r));`;
  try {
    const run = (holder) => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['-e', script, modulePath, tmp, holder]); let output = '';
      child.stdout.on('data', (chunk) => { output += chunk; });
      child.on('error', reject); child.on('close', (code) => code === 0 ? resolve(JSON.parse(output)) : reject(new Error(`child exited ${code}`)));
    });
    const results = await Promise.all([run('process-a'), run('process-b')]);
    assert.equal(results.filter((result) => result.ok).length, 1);
    assert.equal(results.filter((result) => !result.ok)[0].reason, 'lease_conflict');
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('file store replays durable frames and ignores only a torn final frame', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-control-plane-recovery-'));
  try {
    const store = createFileStore(tmp);
    const lease = store.acquireLease({ key: 'recoverable', holder: 'command-1' });
    fs.appendFileSync(path.join(tmp, 'journal.ndjson'), '{"sequence":999');
    const reopened = createFileStore(tmp);
    assert.equal(reopened.snapshot().leases[0].id, lease.lease.id);
    fs.appendFileSync(path.join(tmp, 'journal.ndjson'), '\n{"sequence":999}\n');
    assert.throws(() => createFileStore(tmp).snapshot(), /(Corrupt|Invalid) journal/);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('file store truncates a torn tail before a later mutation is appended', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-control-plane-torn-tail-'));
  try {
    const store = createFileStore(tmp);
    store.putRecord({ id: 'old-record', type: 'request' });
    fs.appendFileSync(path.join(tmp, 'journal.ndjson'), '{"sequence":999');

    createFileStore(tmp).putRecord({ id: 'new-record', type: 'request' });
    const reopened = createFileStore(tmp).snapshot();
    assert.ok(reopened.records.some((record) => record.id === 'old-record'));
    assert.ok(reopened.records.some((record) => record.id === 'new-record'));
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('file store accepts an empty uncommitted journal without a checkpoint', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-control-plane-empty-journal-'));
  try {
    fs.writeFileSync(path.join(tmp, 'journal.ndjson'), '');

    const reopened = createFileStore(tmp).snapshot();

    assert.deepEqual(reopened.records, []);
    assert.deepEqual(reopened.leases, []);
    assert.equal(reopened.journal.length, 0);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('file store checkpoints the journal without losing records or evidence', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-control-plane-checkpoint-'));
  try {
    const store = createFileStore(tmp, { checkpointEntries: 2 });
    store.putRecord({ id: 'record-a', type: 'request' });
    store.putRecord({ id: 'evidence-a', type: 'evidence', digest: 'durable-digest' });
    assert.equal(fs.readFileSync(path.join(tmp, 'journal.ndjson'), 'utf8'), '');

    const reopened = createFileStore(tmp).snapshot();
    assert.deepEqual(reopened.records.map((record) => record.id).sort(), ['evidence-a', 'record-a']);
    assert.equal(reopened.records.find((record) => record.id === 'evidence-a').digest, 'durable-digest');
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('file store fails closed when a compacted checkpoint is missing or corrupt', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-control-plane-checkpoint-corrupt-'));
  try {
    const store = createFileStore(tmp, { checkpointEntries: 1 });
    store.putRecord({ id: 'record-a', type: 'request' });
    fs.writeFileSync(path.join(tmp, 'state.json'), '{not-json');
    assert.throws(() => createFileStore(tmp).snapshot(), /Corrupt state checkpoint/);

    fs.rmSync(path.join(tmp, 'state.json'));
    assert.throws(() => createFileStore(tmp).snapshot(), /Missing state checkpoint/);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('file store accepts a committed journal mutation when state snapshot persistence fails', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-control-plane-state-failure-'));
  const warnings = [];
  try {
    const store = createFileStore(tmp, { logger: { warn: (message) => warnings.push(message) } });
    const originalRename = fs.renameSync;
    fs.renameSync = (from, to) => {
      if (to === path.join(tmp, 'state.json')) throw new Error('simulated snapshot failure');
      return originalRename(from, to);
    };
    try {
      const lease = store.acquireLease({ key: 'journal-survives', holder: 'command-1' });
      assert.equal(lease.ok, true);
    } finally { fs.renameSync = originalRename; }

    const reopened = createFileStore(tmp);
    assert.equal(reopened.snapshot().leases.length, 1);
    assert.match(warnings[0], /State snapshot persistence failed/);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});
