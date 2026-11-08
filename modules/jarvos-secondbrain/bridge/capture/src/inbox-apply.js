'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { CaptureValidationError, simpleCapture, buildSimpleCaptureEvent } = require('./simple-capture');
const { OP_ID_PATTERN, captureOperationRequest } = require('../../../packages/jarvos-ambient/src/intent/capture-operation');
const { TERMINAL } = require('../../../adapters/obsidian/src/vault-mutation-ledger');
const { createConfiguredVaultMutationService } = require('../../../src/vault-mutation-service');
const { resolveConfig } = require('../../config');

const ID = new RegExp(OP_ID_PATTERN);
const MAX_BYTES = 256 * 1024;
const KEYS = new Set(['phanos_request', 'op_id', 'device', 'kind', 'words', 'asked', 'model', 'created', 'date', 'title']);
const TEMPORARY_PROBLEM = 'Not confirmed yet: saving hit a temporary problem; it will be tried again.';

function stat(file) {
  try { return fs.lstatSync(file); } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function directory(root, parts, create = false) {
  const rootInfo = stat(root);
  if (!rootInfo) return null;
  if (!rootInfo.isDirectory()) throw new Error('inbox root must be a real directory, not a symlink');
  let current = root;
  for (const part of parts) {
    current = path.join(current, part);
    let info = stat(current);
    if (!info && create) {
      try { fs.mkdirSync(current); } catch (error) { if (error.code !== 'EEXIST') throw error; }
      info = stat(current);
    }
    if (!info) return null;
    if (!info.isDirectory()) throw new Error('inbox and receipt directories must be real directories, not symlinks');
  }
  return current;
}

function readFile(file, encoding = 'utf8') {
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
    if (length > MAX_BYTES) throw new CaptureValidationError('file exceeds 256 KB');
    return encoding === null ? bytes.subarray(0, length) : bytes.subarray(0, length).toString(encoding);
  } finally { fs.closeSync(fd); }
}

function localTimestamp(date) {
  const pad = (n) => String(n).padStart(2, '0');
  const offset = -date.getTimezoneOffset();
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}${offset < 0 ? '-' : '+'}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`;
}

function parseRequest(source, opId, device) {
  const lines = [...source.matchAll(/[^\n]*(?:\n|$)/g)].filter((line) => line[0]);
  const value = (line) => line[0].replace(/\r?\n$/, '');
  while (lines.length && /^[ \t]*$/.test(value(lines.at(-1)))) lines.pop();
  if (!lines.length || value(lines.at(-1)) !== '<!-- phanos:end -->') return null;
  const marker = lines.pop();
  if (!lines.length || value(lines[0]) !== '---') throw new CaptureValidationError('request must start with --- frontmatter');
  const end = lines.findIndex((line, i) => i > 0 && value(line) === '---');
  if (end < 0) throw new CaptureValidationError('frontmatter must close with ---');
  const fields = Object.create(null);
  for (const line of lines.slice(1, end)) {
    const match = /^([a-z_]+):[ \t]*(.*)$/.exec(value(line));
    if (!match || Object.hasOwn(fields, match[1])) throw new CaptureValidationError('frontmatter fields must be unique key: value lines');
    if (!KEYS.has(match[1])) throw new CaptureValidationError(`unknown frontmatter key: ${match[1]}`);
    fields[match[1]] = match[2];
  }
  if (fields.phanos_request !== 'capture/v1') throw new CaptureValidationError('phanos_request must be capture/v1');
  if (!ID.test(opId) || fields.op_id !== opId) throw new CaptureValidationError('op_id must match its filename and the 8-80 character ID rule');
  if (!ID.test(device) || fields.device !== device) throw new CaptureValidationError('device must match its folder and the 8-80 character ID rule');
  if (!['idea', 'journal', 'note'].includes(fields.kind)) throw new CaptureValidationError('kind must be idea, journal, or note');
  if (fields.words !== 'user') throw new CaptureValidationError('words must be user');
  if (fields.asked !== 'explicit') throw new CaptureValidationError('asked must be explicit');
  if (fields.title !== undefined) {
    if (fields.kind !== 'note') throw new CaptureValidationError('title is allowed only for notes');
    try { fields.title = JSON.parse(fields.title); } catch { throw new CaptureValidationError('title must be JSON double-quoted'); }
    if (typeof fields.title !== 'string' || !fields.title.trim() || [...fields.title].length > 200
      || /^[.-]/.test(fields.title.trim()) || /[/\\\p{Cc}\p{Zl}\p{Zp}]/u.test(fields.title)) {
      throw new CaptureValidationError('title must be one line, 1-200 characters, without leading . or -, slashes, or control characters');
    }
  }
  const start = lines[end].index + lines[end][0].length;
  const text = source.slice(start, marker.index).replace(/\r?\n$/, '').replace(/(?:^|\r?\n)[ \t]*$/, '');
  const date = fields.date ?? fields.created?.split('T')[0];
  const input = { kind: fields.kind, text, words: 'user', asked: 'explicit', source: 'phanos-mobile',
    ...(date !== undefined ? { date } : {}), opId };
  for (const key of ['title', 'model']) if (fields[key] !== undefined) input[key] = fields[key];
  buildSimpleCaptureEvent(input);
  return input;
}

function pendingReceipt(inboxRoot, device, opId, external) {
  const folder = directory(inboxRoot, ['receipts', device]);
  if (!folder) return null;
  const file = path.join(folder, `${opId}.md`);
  const info = stat(file);
  if (!info) return null;
  if (!info.isFile()) throw new Error('receipt target must be a regular file, not a symlink');
  const content = readFile(file, external ? null : 'utf8');
  const header = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content);
  const statuses = header?.[1].match(/^status: ([a-z_]+)\r?$/gm);
  return statuses?.length === 1 && statuses[0].trim() === 'status: not_confirmed' ? content : false;
}

function writeReceipt(service, vaultRoot, inboxRoot, external, device, opId, kind, status, message, applied, expectedContent, assertRootUnchanged = () => {}) {
  const ledger = service.adapter?.ledger;
  const snapshot = ledger?.verify();
  const folder = directory(inboxRoot, ['receipts', device], true);
  if (!folder) throw new Error('inbox root disappeared');
  const file = path.join(folder, `${opId}.md`);
  const info = stat(file);
  if (info && !info.isFile()) throw new Error('receipt target must be a regular file, not a symlink');
  const body = String(message).replace(/[\r\n\u0085\u2028\u2029]+/g, ' ').trim();
  const content = `---\nphanos_receipt: capture/v1\nop_id: ${ID.test(opId) ? opId : JSON.stringify(opId)}\nstatus: ${status}\n${kind ? `kind: ${kind}\n` : ''}applied: ${applied}\n---\n${body}\n`;
  if (external) {
    const temporary = path.join(folder, `.${opId}.${randomUUID()}.tmp`);
    const fd = fs.openSync(temporary, 'wx', 0o644);
    try {
      fs.writeFileSync(fd, content);
      directory(inboxRoot, ['receipts', device]);
      const currentInfo = stat(file);
      if (currentInfo && !currentInfo.isFile()) throw new Error('receipt target must be a regular file, not a symlink');
      const current = currentInfo ? readFile(file, null) : null;
      if (expectedContent === null ? current !== null : current === null || !current.equals(expectedContent)) {
        return { status: 'conflict', obsidian: 'unacknowledged', message: 'receipt changed before replacement' };
      }
      // Compare immediately before rename; the local lock excludes another applier for this pair.
      // Node has no openat/renameat, so the root's identity is rechecked right
      // before and right after the rename; a change stops the run.
      assertRootUnchanged();
      fs.renameSync(temporary, file);
      assertRootUnchanged();
      return { status: 'committed', obsidian: 'acknowledged' };
    } finally {
      fs.closeSync(fd);
      if (directory(inboxRoot, ['receipts', device]) && stat(temporary)) fs.unlinkSync(temporary);
    }
  }
  const vaultRelativePath = path.relative(fs.realpathSync(vaultRoot), file).split(path.sep).join('/');
  const receiptIntent = (before) => {
    const expectedHash = before === null ? null : createHash('sha256').update(before).digest('hex');
    return `inbox-receipt:${createHash('sha256').update(JSON.stringify([vaultRelativePath, status, expectedHash, body])).digest('hex')}`;
  };
  let intentId = receiptIntent(expectedContent);
  const prior = Object.values(snapshot?.operations || {})
    .filter(({ operation }) => operation.vaultId === service.vaultId && operation.vaultRelativePath === vaultRelativePath)
    .sort((a, b) => a.operation.sequence - b.operation.sequence);
  const pending = prior.filter(({ status }) => !TERMINAL.has(status));
  for (const record of pending) {
    service.reconciler.reconcileOne(record);
    if (!TERMINAL.has(ledger.get(record.operation.operationId).status)) {
      return { status: 'pending', obsidian: 'unacknowledged', message: 'receipt pending' };
    }
  }
  const existing = ledger?.get(intentId);
  if (existing) {
    // The first payload owns applied; keep its settled operation and FIFO slot.
    const acknowledged = existing.status === 'acknowledged';
    return { status: acknowledged ? 'already_satisfied' : existing.status,
      obsidian: acknowledged ? 'acknowledged' : 'unacknowledged' };
  }
  if (prior.length) {
    const current = stat(path.join(vaultRoot, vaultRelativePath)) ? readFile(path.join(vaultRoot, vaultRelativePath)) : null;
    // Capture's opportunistic drain may already have settled the earlier write.
    if (pending.length || prior.some((record) => record.status === 'acknowledged' && record.operation.content === current)) {
      expectedContent = current;
      intentId = receiptIntent(expectedContent);
    }
  }
  const mutation = { vaultRelativePath, nextContent: content, intentId };
  return expectedContent === null ? service.createMarkdownFile(mutation)
    : service.applyMarkdownMutation({ ...mutation, expectedContent });
}

function realPath(value) {
  let ancestor = path.resolve(value);
  while (!stat(ancestor)) ancestor = path.dirname(ancestor);
  return path.resolve(fs.realpathSync(ancestor), path.relative(ancestor, path.resolve(value)));
}

function stateDirectory() {
  const stateHome = process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state');
  return realPath(path.resolve(stateHome, 'jarvos'));
}

function acquireLock(vaultRoot, inboxRoot) {
  // Resolve existing ancestors before mkdir, including a state-home symlink.
  const folder = realPath(path.join(stateDirectory(), 'vault-mutations'));
  if (folder === vaultRoot || folder.startsWith(vaultRoot + path.sep)) throw new Error('jarvOS state directory must be outside the vault');
  fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
  const file = path.join(folder, `inbox-${createHash('sha256').update(JSON.stringify([vaultRoot, inboxRoot])).digest('hex')}.lock`);
  for (let attempt = 0; attempt < 2; attempt++) {
    let fd;
    try {
      fd = fs.openSync(file, 'wx', 0o600);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const before = stat(file);
      if (!before?.isFile()) return null;
      // A lock is reclaimed only when its owner is gone: a live run on this
      // host keeps it however long it takes; another host's lock (shared
      // state dir) falls back to the age limit.
      let owner = null;
      try { owner = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* written but not yet filled, or foreign */ }
      const sameHost = owner && owner.host === os.hostname() && Number.isSafeInteger(owner.pid);
      if (sameHost ? processAlive(owner.pid) : Date.now() - before.mtimeMs <= 600000) return null;
      if (stat(file)?.ino !== before.ino) return null;
      fs.unlinkSync(file);
      continue;
    }
    fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, host: os.hostname() }));
    return () => {
      try { if (stat(file)?.ino === fs.fstatSync(fd).ino) fs.unlinkSync(file); }
      finally { fs.closeSync(fd); }
    };
  }
  return null;
}

function processAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

async function applyInbox({ vaultRoot, inboxRoot, limit = 50, capture = simpleCapture, mutationService, now = () => new Date() } = {}) {
  if (typeof vaultRoot !== 'string' || !path.isAbsolute(vaultRoot)) throw new Error('vaultRoot must be an absolute path');
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('limit must be a positive integer');
  if (!fs.statSync(vaultRoot).isDirectory()) throw new Error('vaultRoot must be a directory');
  vaultRoot = path.resolve(vaultRoot);
  const { paths } = resolveConfig();
  // Compare real paths so a symlinked alias of the configured vault keeps its configured folders.
  const realOrResolved = (value) => { try { return fs.realpathSync(value); } catch { return path.resolve(value); } };
  const configuredVault = realOrResolved(vaultRoot) === realOrResolved(paths.vault);
  // Use the configured spelling of the root too, so root and destinations stay lexically consistent for the storage adapter.
  if (configuredVault) vaultRoot = path.resolve(paths.vault);
  const realVault = fs.realpathSync(vaultRoot);
  if (inboxRoot === undefined) {
    directory(realVault, ['phanos']);
    inboxRoot = path.join(vaultRoot, 'phanos');
  }
  if (typeof inboxRoot !== 'string' || !path.isAbsolute(inboxRoot)) throw new Error('inboxRoot must be an absolute path');
  const requestedInboxRoot = inboxRoot;
  inboxRoot = realPath(inboxRoot);
  const stateRoot = stateDirectory();
  const ledgerRoot = realPath(path.join(stateRoot, 'vault-mutations'));
  if (inboxRoot === realVault || inboxRoot === path.parse(inboxRoot).root
    || [stateRoot, ledgerRoot].some((root) => inboxRoot === root || inboxRoot.startsWith(root + path.sep))) {
    throw new Error('inboxRoot must not be the vault root, a filesystem root, or the jarvOS state directory');
  }
  const external = !inboxRoot.startsWith(realVault + path.sep);
  // Identity of the inbox root as resolved now. Before each external receipt
  // write it must still resolve to the same directory, outside the vault, so a
  // parent swapped for a link mid-run can't redirect receipts into the vault.
  const rootIdentity = external ? fs.statSync(inboxRoot) : null;
  const assertRootUnchanged = () => {
    if (!external) return;
    const resolved = realPath(requestedInboxRoot);
    const now = stat(resolved);
    if (resolved !== inboxRoot || !now?.isDirectory() || now.dev !== rootIdentity.dev || now.ino !== rootIdentity.ino
      || resolved === realVault || resolved.startsWith(realVault + path.sep)
      || realVault.startsWith(path.join(resolved, 'receipts') + path.sep)) {
      throw Object.assign(new Error('inbox root changed during the run; stopped before writing receipts'), { ledgerIntegrity: true });
    }
  };
  const receiptsRoot = path.join(inboxRoot, 'receipts');
  if (external && (realVault === receiptsRoot || realVault.startsWith(receiptsRoot + path.sep))) {
    throw new Error('external receipt directory must not overlap the vault');
  }
  const journalDir = configuredVault ? paths.journal : path.join(vaultRoot, 'Journal');
  const notesDir = configuredVault ? paths.notes : path.join(vaultRoot, 'Notes');
  const knowledgeDir = configuredVault ? undefined : path.join(vaultRoot, '.jarvos', 'knowledge');
  if (!fs.constants.O_NOFOLLOW) throw new Error('inbox apply requires filesystem support for O_NOFOLLOW');
  const counts = { saved: 0, not_confirmed: 0, not_saved: 0, invalid: 0, incomplete: 0, skipped: 0 };
  const result = { counts, requests: [], inProgress: false };
  const release = acquireLock(realVault, inboxRoot);
  if (!release) return { ...result, inProgress: true, message: 'another run is in progress' };
  try {
    mutationService ||= createConfiguredVaultMutationService({ vaultRoot, source: 'bridge.inbox-apply' });
    mutationService.adapter?.ledger.verify();
    const inbox = directory(inboxRoot, ['inbox']);
    const items = [];
    if (inbox) for (const device of fs.readdirSync(inbox)) {
      if (device.startsWith('.')) continue;
      const folder = directory(inboxRoot, ['inbox', device]);
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
      directory(inboxRoot, ['inbox', item.device]);
      if (!stat(item.file)?.isFile()) throw new Error('request file changed or is a symlink');
      const record = { device: item.device, opId: item.opId, status: 'skipped' };
      result.requests.push(record);
      const currentReceipt = pendingReceipt(inboxRoot, item.device, item.opId, external);
      if (currentReceipt === false) { counts.skipped++; continue; }
      const applied = localTimestamp(now());
      let input;
      let status;
      let message;
      try {
        input = parseRequest(readFile(item.file), item.opId, item.device);
      } catch (error) {
        if (['EIO', 'ETIMEDOUT', 'ETIME', 'EAGAIN', 'EBUSY', 'EINTR', 'ENODATA', 'ENOENT', 'ENXIO', 'EACCES', 'EPERM'].includes(error.code)) {
          record.status = 'incomplete'; counts.incomplete++; continue;
        }
        status = error.validation === true ? 'invalid' : 'not_confirmed';
        message = error.validation === true ? error.message : TEMPORARY_PROBLEM;
      }
      if (!status && !input) { record.status = 'incomplete'; counts.incomplete++; continue; }
      processed++;
      if (!status) {
        try {
          const saved = await capture(input, { vaultRoot, journalDir, notesDir, knowledgeDir, mutationService });
          const intentId = captureOperationRequest(buildSimpleCaptureEvent(input)).intentId;
          const unresolved = Object.values(mutationService.adapter?.ledger.verify().operations || {})
            .some(({ operation, status }) => operation.vaultId === mutationService.vaultId
              && operation.operationId.startsWith(`${intentId}:`)
              && ['planned', 'dispatched', 'unknown_after_dispatch', 'local_mutating', 'local_applied', 'blocked'].includes(status));
          const pending = saved.result?.artifactReceipt?.artifacts?.some((artifact) => ['note', 'journal'].includes(artifact.kind)
            && ['saved_locally_sync_pending', 'deferred'].includes(artifact.outcome)) || unresolved;
          status = pending ? 'not_confirmed' : saved.ok ? 'saved' : 'not_saved';
          message = saved.message;
        } catch (error) {
          if (error.ledgerIntegrity === true) throw error;
          status = error.validation === true ? 'invalid' : 'not_confirmed';
          message = error.validation === true ? error.message : TEMPORARY_PROBLEM;
        }
      }
      assertRootUnchanged();
      const receipt = await writeReceipt(mutationService, vaultRoot, inboxRoot, external, item.device, item.opId, input?.kind, status, message, applied, currentReceipt, assertRootUnchanged);
      if (!['committed', 'already_satisfied'].includes(receipt.status) || receipt.obsidian !== 'acknowledged') {
        record.receipt = { status: receipt.status, obsidian: receipt.obsidian, ...(receipt.message ? { message: receipt.message } : {}) };
      }
      record.status = status;
      counts[status]++;
    }
    return result;
  } catch (error) {
    if (error.ledgerIntegrity !== true) throw error;
    return { ...result, stopped: 'ledger integrity', reason: 'The mutation ledger failed its integrity or permission check; no further requests were applied.' };
  } finally { release(); }
}

module.exports = { applyInbox };
