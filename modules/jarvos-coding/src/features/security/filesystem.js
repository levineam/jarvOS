'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

async function syncDirectory(directory) {
  let handle;
  try {
    handle = await fs.open(directory, 'r');
    await handle.sync();
  } catch (_) {
    // Some filesystems do not support directory fsync. File fsync still holds.
  } finally {
    await handle?.close();
  }
}

async function durableSecurityWrite(file, contents) {
  const directory = path.dirname(file);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = path.join(
    directory,
    `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`,
  );
  let handle;
  try {
    handle = await fs.open(temporary, 'wx', 0o600);
    await handle.writeFile(contents);
    await handle.sync();
  } finally {
    await handle?.close();
  }
  await fs.rename(temporary, file);
  await fs.chmod(file, 0o600);
  await syncDirectory(directory);
}

module.exports = { durableSecurityWrite, syncDirectory };
