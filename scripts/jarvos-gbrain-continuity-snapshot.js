#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {
  CONTINUITY_MODULE_ID,
  HEALTH_MODULE_DIRECTORY,
  modulePath,
  ownerOnly,
  validateSnapshot,
} = require('../lib/jarvos-doctor-modules');

const MAX_SNAPSHOT_BYTES = 64 * 1024;

function fail(reasonClass) {
  const error = new Error(`continuity snapshot rejected (${reasonClass})`);
  error.reasonClass = reasonClass;
  throw error;
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--workspace' && argv[index + 1]) options.workspace = argv[++index];
    else if (value === '--input' && argv[index + 1]) options.input = argv[++index];
    else fail('arguments-invalid');
  }
  if (!path.isAbsolute(options.workspace || '') || !path.isAbsolute(options.input || '')) fail('arguments-invalid');
  return options;
}

function assertDirectory(directory, { create = false } = {}) {
  try {
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || !ownerOnly(stat)) fail('directory-unsafe');
  } catch (error) {
    if (error?.code !== 'ENOENT' || !create) throw error;
    fs.mkdirSync(directory, { mode: 0o700 });
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || !ownerOnly(stat)) fail('directory-unsafe');
  }
}

function readOwnerOnlyFile(filePath, { required = true } = {}) {
  let descriptor;
  try {
    const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0);
    descriptor = fs.openSync(filePath, flags);
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || !ownerOnly(stat) || stat.size > MAX_SNAPSHOT_BYTES) fail('file-unsafe');
    return fs.readFileSync(descriptor, 'utf8');
  } catch (error) {
    if (!required && error?.code === 'ENOENT') return null;
    throw error;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function parseContinuitySnapshot(source, now) {
  let snapshot;
  try {
    snapshot = JSON.parse(source);
  } catch {
    fail('snapshot-invalid');
  }
  const validation = validateSnapshot(snapshot, now);
  if (!validation.ok || snapshot.moduleId !== CONTINUITY_MODULE_ID) fail('snapshot-invalid');
  return snapshot;
}

function writeContinuitySnapshot({ workspace, input, now = new Date() }) {
  if (!path.isAbsolute(workspace || '') || !path.isAbsolute(input || '')) fail('arguments-invalid');
  assertDirectory(workspace);

  const inputStat = fs.lstatSync(input);
  if (inputStat.isSymbolicLink()) fail('file-unsafe');
  const snapshot = parseContinuitySnapshot(readOwnerOnlyFile(input), now);

  const jarvosDirectory = path.join(workspace, '.jarvos');
  const healthDirectory = path.join(workspace, HEALTH_MODULE_DIRECTORY);
  assertDirectory(jarvosDirectory, { create: true });
  assertDirectory(healthDirectory, { create: true });

  const target = modulePath(workspace, CONTINUITY_MODULE_ID);
  const existingSource = readOwnerOnlyFile(target, { required: false });
  if (existingSource !== null) {
    const existing = parseContinuitySnapshot(existingSource, now);
    if (snapshot.generation <= existing.generation) fail('generation-not-newer');
  }

  const temporary = path.join(healthDirectory, `.${CONTINUITY_MODULE_ID}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`);
  let descriptor;
  try {
    descriptor = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
    fs.writeFileSync(descriptor, `${JSON.stringify(snapshot)}\n`, 'utf8');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporary, target);
    const directoryDescriptor = fs.openSync(healthDirectory, fs.constants.O_RDONLY);
    try {
      fs.fsyncSync(directoryDescriptor);
    } finally {
      fs.closeSync(directoryDescriptor);
    }
  } catch (error) {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    try { fs.unlinkSync(temporary); } catch {}
    throw error;
  }

  return { ok: true, moduleId: CONTINUITY_MODULE_ID, generation: snapshot.generation };
}

function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    const result = writeContinuitySnapshot(options);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    const reasonClass = error?.reasonClass || 'snapshot-write-failed';
    process.stderr.write(`continuity snapshot rejected (${reasonClass})\n`);
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = { MAX_SNAPSHOT_BYTES, parseArgs, writeContinuitySnapshot };
