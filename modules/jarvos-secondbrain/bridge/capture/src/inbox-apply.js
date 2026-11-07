'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { simpleCapture, buildSimpleCaptureEvent } = require('./simple-capture');
const { OP_ID_PATTERN } = require('../../../packages/jarvos-ambient/src/intent/capture-operation');

const ID = new RegExp(OP_ID_PATTERN);
const MAX_BYTES = 256 * 1024;
const KEYS = new Set(['phanos_request', 'op_id', 'device', 'kind', 'words', 'asked', 'model', 'created', 'date', 'title']);

function stat(file) {
  try { return fs.lstatSync(file); } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function directory(root, parts, create = false) {
  let current = root;
  for (const part of parts) {
    current = path.join(current, part);
    if (create && !stat(current)) fs.mkdirSync(current);
    const info = stat(current);
    if (!info) return null;
    if (!info.isDirectory()) throw new Error('inbox and receipt directories must be real directories, not symlinks');
  }
  return current;
}

function readFile(file) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    if (!fs.fstatSync(fd).isFile()) throw new Error('request and receipt targets must be regular files, not symlinks');
    const bytes = Buffer.alloc(MAX_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = fs.readSync(fd, bytes, length, bytes.length - length, length);
      if (!count) break;
      length += count;
    }
    if (length > MAX_BYTES) throw new Error('file exceeds 256 KB');
    return bytes.subarray(0, length).toString('utf8');
  } finally { fs.closeSync(fd); }
}

function localTimestamp(date) {
  const pad = (n) => String(n).padStart(2, '0');
  const offset = -date.getTimezoneOffset();
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}${offset < 0 ? '-' : '+'}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`;
}

function parseRequest(source, opId, device, today) {
  const lines = [...source.matchAll(/[^\n]*(?:\n|$)/g)].filter((line) => line[0]);
  const value = (line) => line[0].replace(/\r?\n$/, '');
  while (lines.length && /^[ \t]*$/.test(value(lines.at(-1)))) lines.pop();
  if (!lines.length || value(lines.at(-1)) !== '<!-- phanos:end -->') return null;
  const marker = lines.pop();
  if (!lines.length || value(lines[0]) !== '---') throw new Error('request must start with --- frontmatter');
  const end = lines.findIndex((line, i) => i > 0 && value(line) === '---');
  if (end < 0) throw new Error('frontmatter must close with ---');
  const fields = Object.create(null);
  for (const line of lines.slice(1, end)) {
    const match = /^([a-z_]+):[ \t]*(.*)$/.exec(value(line));
    if (!match || Object.hasOwn(fields, match[1])) throw new Error('frontmatter fields must be unique key: value lines');
    if (!KEYS.has(match[1])) throw new Error(`unknown frontmatter key: ${match[1]}`);
    fields[match[1]] = match[2];
  }
  if (fields.phanos_request !== 'capture/v1') throw new Error('phanos_request must be capture/v1');
  if (!ID.test(opId) || fields.op_id !== opId) throw new Error('op_id must match its filename and the 8-80 character ID rule');
  if (!ID.test(device) || fields.device !== device) throw new Error('device must match its folder and the 8-80 character ID rule');
  if (!['idea', 'journal', 'note'].includes(fields.kind)) throw new Error('kind must be idea, journal, or note');
  if (fields.words !== 'user') throw new Error('words must be user');
  if (fields.asked !== 'explicit') throw new Error('asked must be explicit');
  if (fields.title !== undefined) {
    if (fields.kind !== 'note') throw new Error('title is allowed only for notes');
    try { fields.title = JSON.parse(fields.title); } catch { throw new Error('title must be JSON double-quoted'); }
    if (typeof fields.title !== 'string' || !fields.title.trim() || [...fields.title].length > 200
      || /^[.-]/.test(fields.title.trim()) || /[/\\\p{Cc}\p{Zl}\p{Zp}]/u.test(fields.title)) {
      throw new Error('title must be one line, 1-200 characters, without leading . or -, slashes, or control characters');
    }
  }
  const start = lines[end].index + lines[end][0].length;
  const text = source.slice(start, marker.index).replace(/\r?\n$/, '').replace(/(?:^|\r?\n)[ \t]*$/, '');
  const input = { kind: fields.kind, text, words: 'user', asked: 'explicit', source: 'phanos-mobile',
    date: fields.date ?? today, opId };
  for (const key of ['title', 'model']) if (fields[key] !== undefined) input[key] = fields[key];
  buildSimpleCaptureEvent(input);
  return input;
}

function receiptPending(vaultRoot, device, opId) {
  const folder = directory(vaultRoot, ['phanos', 'receipts', device]);
  if (!folder) return true;
  const file = path.join(folder, `${opId}.md`);
  const info = stat(file);
  if (!info) return true;
  if (!info.isFile()) throw new Error('receipt target must be a regular file, not a symlink');
  const header = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(readFile(file));
  const statuses = header?.[1].match(/^status: ([a-z_]+)\r?$/gm);
  return statuses?.length === 1 && statuses[0].trim() === 'status: not_confirmed';
}

function writeReceipt(vaultRoot, device, opId, kind, status, message, applied) {
  const folder = directory(vaultRoot, ['phanos', 'receipts', device], true);
  const target = path.join(folder, `${opId}.md`);
  const assertTarget = () => {
    directory(vaultRoot, ['phanos', 'receipts', device]);
    const info = stat(target);
    if (info && !info.isFile()) throw new Error('receipt target must be a regular file, not a symlink');
  };
  assertTarget();
  const temporary = path.join(folder, `.${randomUUID()}.tmp`);
  const body = String(message).replace(/[\r\n\u0085\u2028\u2029]+/g, ' ').trim();
  const content = `---\nphanos_receipt: capture/v1\nop_id: ${ID.test(opId) ? opId : JSON.stringify(opId)}\nstatus: ${status}\n${kind ? `kind: ${kind}\n` : ''}applied: ${applied}\n---\n${body}\n`;
  try {
    fs.writeFileSync(temporary, content, { flag: 'wx', mode: 0o600 });
    assertTarget();
    fs.renameSync(temporary, target);
  } finally {
    directory(vaultRoot, ['phanos', 'receipts', device]);
    if (stat(temporary)?.isFile()) fs.unlinkSync(temporary);
  }
}

function acquireLock(vaultRoot) {
  const stateHome = process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state');
  const folder = path.resolve(stateHome, 'jarvos', 'vault-mutations');
  // Resolve existing ancestors before mkdir, including a state-home symlink.
  let ancestor = folder;
  while (!stat(ancestor)) ancestor = path.dirname(ancestor);
  const resolved = path.resolve(fs.realpathSync(ancestor), path.relative(ancestor, folder));
  if (resolved === vaultRoot || resolved.startsWith(vaultRoot + path.sep)) throw new Error('jarvOS state directory must be outside the vault');
  fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
  const file = path.join(folder, `inbox-${createHash('sha256').update(vaultRoot).digest('hex')}.lock`);
  for (let attempt = 0; attempt < 2; attempt++) {
    let fd;
    try {
      fd = fs.openSync(file, 'wx', 0o600);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const before = stat(file);
      if (!before?.isFile() || Date.now() - before.mtimeMs <= 600000) return null;
      if (stat(file)?.ino !== before.ino) return null;
      fs.unlinkSync(file);
      continue;
    }
    return () => {
      try { if (stat(file)?.ino === fs.fstatSync(fd).ino) fs.unlinkSync(file); }
      finally { fs.closeSync(fd); }
    };
  }
  return null;
}

async function applyInbox({ vaultRoot, limit = 50, capture = simpleCapture, now = () => new Date() } = {}) {
  if (typeof vaultRoot !== 'string' || !path.isAbsolute(vaultRoot)) throw new Error('vaultRoot must be an absolute path');
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('limit must be a positive integer');
  if (!fs.statSync(vaultRoot).isDirectory()) throw new Error('vaultRoot must be a directory');
  vaultRoot = path.resolve(vaultRoot);
  if (!fs.constants.O_NOFOLLOW) throw new Error('inbox apply requires filesystem support for O_NOFOLLOW');
  const counts = { saved: 0, not_confirmed: 0, not_saved: 0, invalid: 0, incomplete: 0, skipped: 0 };
  const result = { counts, requests: [], inProgress: false };
  const release = acquireLock(fs.realpathSync(vaultRoot));
  if (!release) return { ...result, inProgress: true, message: 'another run is in progress' };
  try {
    const inbox = directory(vaultRoot, ['phanos', 'inbox']);
    const items = [];
    if (inbox) for (const device of fs.readdirSync(inbox)) {
      if (device.startsWith('.')) continue;
      const folder = directory(vaultRoot, ['phanos', 'inbox', device]);
      for (const name of fs.readdirSync(folder)) {
        if (name.startsWith('.') || !name.endsWith('.md')) continue;
        const file = path.join(folder, name);
        const info = stat(file);
        if (!info) continue;
        if (info.isSymbolicLink()) throw new Error('request files must not be symlinks');
        if (!info.isFile()) continue;
        items.push({ file, device, opId: name.slice(0, -3), mtime: info.mtimeMs });
      }
    }
    items.sort((a, b) => a.mtime - b.mtime || a.file.localeCompare(b.file));
    let processed = 0;
    for (const item of items) {
      if (processed >= limit) break;
      directory(vaultRoot, ['phanos', 'inbox', item.device]);
      if (!stat(item.file)?.isFile()) throw new Error('request file changed or is a symlink');
      const record = { device: item.device, opId: item.opId, status: 'skipped' };
      result.requests.push(record);
      if (!receiptPending(vaultRoot, item.device, item.opId)) { counts.skipped++; continue; }
      processed++;
      const applied = localTimestamp(now());
      let input;
      let status;
      let message;
      try {
        input = parseRequest(readFile(item.file), item.opId, item.device, applied.slice(0, 10));
      } catch (error) {
        if (error.code) throw error;
        status = 'invalid'; message = error.message;
      }
      if (!status && !input) { record.status = 'incomplete'; counts.incomplete++; continue; }
      if (!status) {
        try {
          const saved = await capture(input, { vaultRoot, journalDir: path.join(vaultRoot, 'Journal'), notesDir: path.join(vaultRoot, 'Notes') });
          status = saved.ok ? 'saved' : saved.message.startsWith('Not confirmed yet') ? 'not_confirmed'
            : saved.message.includes('this operation id was already used for different content') ? 'invalid' : 'not_saved';
          message = saved.message;
        } catch (error) {
          if (error.code) throw error;
          status = 'invalid'; message = error.message;
        }
      }
      writeReceipt(vaultRoot, item.device, item.opId, input?.kind, status, message, applied);
      record.status = status;
      counts[status]++;
    }
    return result;
  } finally { release(); }
}

module.exports = { applyInbox };
