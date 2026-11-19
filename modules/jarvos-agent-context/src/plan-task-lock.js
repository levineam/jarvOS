'use strict';

const fs = require('node:fs');
const { randomUUID } = require('node:crypto');
const { spawnSync } = require('node:child_process');

const { O_RDWR, O_CREAT, O_NOFOLLOW, O_NONBLOCK } = fs.constants;
const FORMAT = Buffer.from('jarvos.plan-task-kernel-lock/v1\n');

function tryLock(fd) {
  const command = process.platform === 'darwin' ? ['/usr/bin/lockf', '-s', '-t', '0', '3']
    : process.platform === 'linux' ? ['/usr/bin/flock', '-n', '3'] : null;
  if (!command) return false;
  // The utility and Node share the open file description; Node keeps the lock after the utility exits.
  return spawnSync(command[0], command.slice(1), {
    stdio: ['ignore', 'ignore', 'ignore', fd], timeout: 2000, env: { PATH: '/usr/bin:/bin' },
  }).status === 0;
}

function namesOpenedFile(file, fd) {
  const current = fs.lstatSync(file, { bigint: true, throwIfNoEntry: false });
  if (!current?.isFile()) return false;
  const opened = fs.fstatSync(fd, { bigint: true });
  return current.dev === opened.dev && current.ino === opened.ino;
}

function unlinkOwned(file, fd) {
  if (namesOpenedFile(file, fd)) fs.unlinkSync(file);
}

function isPrivateFile(stat) {
  return stat.isFile() && (stat.mode & 0o777) === 0o600 && stat.uid === process.getuid();
}

function recover(file) {
  const fd = fs.openSync(file, O_RDWR | O_NOFOLLOW | O_NONBLOCK);
  try {
    const stat = fs.fstatSync(fd);
    if (!isPrivateFile(stat) || stat.size !== FORMAT.length) return false;
    const marker = Buffer.alloc(FORMAT.length);
    if (fs.readSync(fd, marker, 0, marker.length, 0) !== marker.length || !marker.equals(FORMAT) || !tryLock(fd)) return false;
    // A displaced inode cannot authorize removal of the current pathname.
    if (!namesOpenedFile(file, fd)) return false;
    fs.unlinkSync(file);
    return true;
  } finally { fs.closeSync(fd); }
}

function acquirePlanTaskLock(file) {
  const guard = `${file}.guard`;
  const stage = `${file}.stage-${randomUUID()}`;
  let guardFd, fd, published = false;
  try {
    // All current writers hold this stable inode through the pointer rename and
    // cleanup. The visible .lock still excludes the previous O_EXCL writer.
    guardFd = fs.openSync(guard, O_RDWR | O_CREAT | O_NOFOLLOW | O_NONBLOCK, 0o600);
    if (!isPrivateFile(fs.fstatSync(guardFd)) || !tryLock(guardFd) || !namesOpenedFile(guard, guardFd)) return null;
    fd = fs.openSync(stage, 'wx', 0o600);
    if (!tryLock(fd)) return null;
    // Publish only a complete, already-locked marker. Existing empty legacy locks stay held.
    fs.writeFileSync(fd, FORMAT);
    try { fs.linkSync(stage, file); }
    catch (error) {
      if (error.code !== 'EEXIST' || !recover(file)) return null;
      fs.linkSync(stage, file);
    }
    if (!namesOpenedFile(file, fd)) return null;
    published = true;
    return {
      ownsPath: () => namesOpenedFile(guard, guardFd) && namesOpenedFile(file, fd),
      release() {
        try { unlinkOwned(file, fd); }
        finally {
          try { fs.closeSync(fd); }
          finally { fs.closeSync(guardFd); }
        }
      },
    };
  } catch { return null; }
  finally {
    if (fd !== undefined) {
      try { unlinkOwned(stage, fd); } catch { /* Leave an unselected staging name. */ }
      if (!published) fs.closeSync(fd);
    }
    if (!published && guardFd !== undefined) fs.closeSync(guardFd);
  }
}

module.exports = { acquirePlanTaskLock };
