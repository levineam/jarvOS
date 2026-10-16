'use strict';
const { spawn } = require('node:child_process');
const { createHash } = require('node:crypto');
const { trustedExecutable } = require('../../modules/jarvos-runtime-kit/src/trusted-native-command');

const MAX_BYTES = 256 * 1024;
const MAX_TRANSPORT_BYTES = 32 * 1024 * 1024;
const MAX_PAGES = 8;
const ITEM_PAGE_SIZE = 100;
const MAX_TURN_PAGES = 8;
const TIMEOUT_MS = 2500;
const TURN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
// Native JSON cannot forge this in-process marker. The digest covers original wire item bytes.
const ITEM_WIRE_DIGEST = Symbol('native-item-wire-digest');
const OVERSIZE = Symbol('oversize-field');
const ITEM_FIELDS = new Set(['id', 'type', 'namespace', 'name', 'output', 'content', 'text', 'phase', 'status', 'exitCode']);

// Parse every token, but retain only envelope/identity fields and bounded candidate input fields.
// Large tool strings/objects never become a JSON frame or an in-memory item body.
function projectedFrames(onMessage) {
  let stack = []; let root; let complete = false; let token = ''; let tokenBytes = 0;
  let tokenKind; let escape = false; let unicode = 0; let capture; let itemHash; let nodes = 0; let retainedBytes = 0; let bytes = 0;
  const stringBoundary = /["\\\x00-\x1f]/g;
  const invalid = () => { throw new Error('native-reader-invalid'); };
  function pathForValue() {
    const parent = stack.at(-1);
    if (!parent) { if (complete) invalid(); return []; }
    if (parent.kind === 'object' && parent.state !== 'value') invalid();
    if (parent.kind === 'array' && !['value', 'valueOrEnd'].includes(parent.state)) invalid();
    return [...parent.path, parent.kind === 'array' ? parent.index : parent.key];
  }
  function retained(path) {
    if (path.length === 1) return ['id', 'error'].includes(path[0]);
    if (path[0] !== 'result') return false;
    if (path.length === 2) return path[1] === 'nextCursor';
    if (path[1] !== 'data') return false;
    if (path.length === 4) return ['turnId', 'id', 'startedAt'].includes(path[3]);
    return path.length === 5 && path[3] === 'item' && ITEM_FIELDS.has(path[4]);
  }
  function structural(path) {
    return path.length === 0 || (path[0] === 'result' && (path.length === 1
      || (path[1] === 'data' && (path.length === 2 || path.length === 3 || (path.length === 4 && path[3] === 'item')))));
  }
  function raw(value) {
    if (itemHash) itemHash.update(value);
    if (capture && capture.parts) {
      capture.bytes += Buffer.byteLength(value);
      if (capture.bytes > MAX_BYTES) capture.parts = null;
      else capture.parts.push(value);
    }
  }
  function begin() {
    if (++nodes > 100000) throw new Error('native-reader-structure-limit');
    const path = pathForValue();
    if (path.length === 4 && path[0] === 'result' && path[1] === 'data' && path[3] === 'item') itemHash = createHash('sha256');
    if (!capture && retained(path)) capture = { path, depth: stack.length, parts: [], bytes: 0 };
    return path;
  }
  function end(value, path) {
    if (capture && capture.depth === stack.length) {
      value = capture.parts ? JSON.parse(capture.parts.join('')) : OVERSIZE;
      if (capture.path.length < 5) {
        if (value === OVERSIZE) throw new Error('native-reader-byte-limit');
        retainedBytes += Buffer.byteLength(JSON.stringify(value));
        if (retainedBytes > MAX_BYTES) throw new Error('native-reader-byte-limit');
      }
      capture = null;
    }
    if (itemHash && path.length === 4 && path[3] === 'item') {
      if (value && typeof value === 'object') value[ITEM_WIRE_DIGEST] = itemHash.digest('hex');
      itemHash = null;
      const projected = compactItem({ item: value });
      value = projected.item;
      value[ITEM_WIRE_DIGEST] = projected[ITEM_WIRE_DIGEST];
      retainedBytes += Buffer.byteLength(JSON.stringify(value));
      if (retainedBytes > MAX_BYTES) throw new Error('native-reader-byte-limit');
    }
    const parent = stack.at(-1);
    if (!parent) { root = value; complete = true; return; }
    if (parent.value && (structural(path) || retained(path))) parent.value[parent.kind === 'array' ? parent.index : parent.key] = value;
    parent.state = 'commaOrEnd';
    if (parent.kind === 'array') parent.index++;
  }
  function punctuation(char) {
    const parent = stack.at(-1);
    if (char === '{' || char === '[') {
      const path = begin(); raw(char);
      if (stack.length >= 64) throw new Error('native-reader-structure-limit');
      stack.push({ kind: char === '{' ? 'object' : 'array', path,
        state: char === '{' ? 'keyOrEnd' : 'valueOrEnd', index: 0,
        value: structural(path) ? (char === '{' ? Object.create(null) : []) : null, keys: new Set() });
    } else if (char === '}' || char === ']') {
      if (!parent || parent.kind !== (char === '}' ? 'object' : 'array')
        || !['commaOrEnd', char === '}' ? 'keyOrEnd' : 'valueOrEnd'].includes(parent.state)) invalid();
      raw(char); stack.pop(); end(parent.value, parent.path);
    } else if (char === ':') {
      if (parent?.kind !== 'object' || parent.state !== 'colon') invalid();
      raw(char); parent.state = 'value';
    } else {
      if (parent?.state !== 'commaOrEnd') invalid();
      raw(char); parent.state = parent.kind === 'object' ? 'key' : 'value';
    }
  }
  function tokenEnd() {
    const parent = stack.at(-1);
    if (tokenKind === 'key') {
      if (tokenBytes > 4096) throw new Error('native-reader-structure-limit');
      const key = JSON.parse(token);
      if (parent.keys.has(key)) invalid();
      parent.keys.add(key); parent.key = key; parent.state = 'colon';
    } else {
      let value;
      if (tokenKind === 'primitive') {
        try { value = JSON.parse(token); } catch { invalid(); }
        if (value !== null && !['number', 'boolean'].includes(typeof value)) invalid();
      }
      end(value, pathForValue());
    }
    tokenKind = null; token = ''; tokenBytes = 0;
  }
  return (chunk) => {
    bytes += Buffer.byteLength(chunk);
    if (bytes > MAX_TRANSPORT_BYTES) throw new Error('native-reader-transport-limit');
    let i = 0;
    while (i < chunk.length) {
      const char = chunk[i];
      if (tokenKind === 'string' || tokenKind === 'key') {
        // Scan ordinary text in one slice, independent of the size of a discarded string.
        let stop = i;
        if (!escape && !unicode) { stringBoundary.lastIndex = i; stop = stringBoundary.exec(chunk)?.index ?? chunk.length; }
        if (stop > i) {
          const part = chunk.slice(i, stop); raw(part);
          if (tokenKind === 'key') { token += part; tokenBytes += Buffer.byteLength(part); if (tokenBytes > 4096) throw new Error('native-reader-structure-limit'); }
          i = stop; continue;
        }
        raw(char); i++;
        if (tokenKind === 'key') { token += char; tokenBytes++; }
        if (unicode) { if (!/[0-9a-f]/i.test(char)) invalid(); unicode--; }
        else if (escape) { if (char === 'u') unicode = 4; else if (!'"\\/bfnrt'.includes(char)) invalid(); escape = false; }
        else if (char === '\\') escape = true;
        else if (char === '"') tokenEnd();
        else if (char.charCodeAt(0) < 32) invalid();
      } else if (tokenKind === 'primitive') {
        if (/[ \t\r\n,}\]]/.test(char)) tokenEnd();
        else { raw(char); token += char; if (token.length > 128) invalid(); i++; }
      } else if (/[ \t\r\n]/.test(char)) {
        raw(char); i++;
        if (char === '\n') {
          if (!complete || stack.length) invalid();
          onMessage(root); root = undefined; complete = false; nodes = 0; retainedBytes = 0;
        }
      } else if ('{}[]:,'.includes(char)) { punctuation(char); i++; }
      else if (char === '"') {
        const parent = stack.at(-1);
        const key = parent?.kind === 'object' && ['key', 'keyOrEnd'].includes(parent.state);
        if (!key) begin();
        raw(char); tokenKind = key ? 'key' : 'string'; token = key ? '"' : ''; tokenBytes = 1; i++;
      } else { begin(); tokenKind = 'primitive'; token = ''; }
    }
  };
}

function compactItem(entry) {
  const item = entry?.item;
  if (!item || typeof item !== 'object' || typeof item.type !== 'string') throw new Error('native-reader-identity');
  const fields = item.type === 'userMessage' ? ['content'] : item.type === 'agentMessage' ? ['phase', 'text']
    : item.type === 'functionCallOutput' && item.namespace === 'codex_app' && item.name === 'send_message_to_thread' ? ['namespace', 'name', 'output']
      : ['status', 'exitCode'];
  const projected = { id: item.id, type: item.type };
  for (const field of ['id', 'type', ...fields]) {
    if (item[field] === OVERSIZE) throw new Error('native-reader-byte-limit');
    if (Object.hasOwn(item, field)) projected[field] = item[field];
  }
  return { turnId: entry.turnId, item: projected, [ITEM_WIRE_DIGEST]: item[ITEM_WIRE_DIGEST] };
}

// Only stored item reads: never start/resume a thread, execute a hook or call a model.
function readNativeTurn({ sessionId, turnId, command, env = process.env }) {
  return new Promise((resolve, reject) => {
    if (!trustedExecutable(command)) { reject(new Error('native-reader-unavailable')); return; }
    const child = spawn(command, ['app-server', '--listen', 'stdio://'], {
      env: { ...env, PATH: '/usr/bin:/bin' }, stdio: ['pipe', 'pipe', 'ignore'],
    });
    let projectedBytes = 0; let pages = 0; let turnPages = 0; let settled = false;
    const items = []; const cursors = new Set(); const turnCursors = new Set(); const turnIds = new Set(); let startedAt;
    const timer = setTimeout(() => finish(new Error('native-reader-timeout')), TIMEOUT_MS);
    function finish(error) {
      if (settled) return;
      settled = true; clearTimeout(timer);
      child.kill('SIGKILL');
      if (error) reject(error); else resolve({ items, startedAt });
    }
    function send(method, params, id) {
      child.stdin.write(`${JSON.stringify({ method, params, ...(id ? { id } : {}) })}\n`);
    }
    function page(cursor) {
      if (++pages > MAX_PAGES) { finish(new Error('native-reader-page-limit')); return; }
      send('thread/items/list', { threadId: sessionId, turnId, sortDirection: 'asc', limit: ITEM_PAGE_SIZE, ...(cursor ? { cursor } : {}) }, 2);
    }
    function turnPage(cursor) {
      if (++turnPages > MAX_TURN_PAGES) { finish(new Error('native-reader-turn-page-limit')); return; }
      send('thread/turns/list', { threadId: sessionId, sortDirection: 'desc', itemsView: 'notLoaded', limit: 25, ...(cursor ? { cursor } : {}) }, 3);
    }
    child.stdin.on('error', () => finish(new Error('native-reader-unavailable')));
    child.on('error', () => finish(new Error('native-reader-unavailable')));
    child.on('exit', () => { if (!settled) finish(new Error('native-reader-exited')); });
    const parse = projectedFrames((message) => {
        if (settled) return;
        if (message.error) { finish(new Error('native-reader-unsupported')); return; }
        if (message.id === 1) {
          send('initialized', {});
          turnPage();
        } else if (message.id === 3) {
          const turns = message.result?.data;
          if (startedAt !== undefined || !Array.isArray(turns) || turns.length > 25 || turns.some((turn) => typeof turn?.id !== 'string' || !TURN_ID.test(turn.id) || turnIds.has(turn.id))) {
            finish(new Error('native-reader-turn-identity')); return;
          }
          for (const turn of turns) {
            if (turnIds.has(turn.id)) { finish(new Error('native-reader-turn-identity')); return; }
            turnIds.add(turn.id);
          }
          const target = turns.find((turn) => turn.id === turnId);
          const cursor = message.result.nextCursor;
          if (cursor != null && (typeof cursor !== 'string' || !cursor || Buffer.byteLength(cursor) > 4096 || turnCursors.has(cursor))) {
            finish(new Error('native-reader-invalid-cursor')); return;
          }
          if (target) {
            if (!Number.isFinite(target.startedAt)) { finish(new Error('native-reader-turn-identity')); return; }
            // PreCompact supplied the target; metadata only supplies its original start.
            startedAt = target.startedAt; page();
          } else if (cursor == null) finish(new Error('native-reader-turn-identity'));
          else { turnCursors.add(cursor); turnPage(cursor); }
        }
        else if (message.id === 2) {
          if (!Number.isFinite(startedAt)) { finish(new Error('native-reader-turn-identity')); return; }
          const result = message.result;
          if (!Array.isArray(result?.data) || result.data.length > ITEM_PAGE_SIZE || result.data.some((entry) => entry.turnId !== turnId || !entry.item || typeof entry.item.id !== 'string')) {
            finish(new Error('native-reader-identity')); return;
          }
          const projected = result.data.map(compactItem);
          projectedBytes += Buffer.byteLength(JSON.stringify(projected));
          if (projectedBytes > MAX_BYTES) { finish(new Error('native-reader-byte-limit')); return; }
          items.push(...projected);
          if (result.nextCursor == null) finish();
          else if (typeof result.nextCursor !== 'string' || !result.nextCursor || cursors.has(result.nextCursor)) finish(new Error('native-reader-invalid-cursor'));
          else { cursors.add(result.nextCursor); page(result.nextCursor); }
        }
    });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      if (settled) return;
      try { parse(chunk); } catch (error) { finish(error); }
    });
    send('initialize', { clientInfo: { name: 'jarvos_assignment_context', version: '1' }, capabilities: { experimentalApi: true } }, 1);
  });
}

module.exports = { readNativeTurn, projectedFrames, MAX_BYTES, MAX_TRANSPORT_BYTES, MAX_PAGES, ITEM_PAGE_SIZE, MAX_TURN_PAGES, TIMEOUT_MS, ITEM_WIRE_DIGEST };
