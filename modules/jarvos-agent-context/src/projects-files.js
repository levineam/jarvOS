'use strict';

const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');

const CONTRACT = 'jarvos.projects-files/v1';
const MAX_PACKET_BYTES = 60_000;

// Ported from the Desktop project-files parser: flat scalars and a JSON
// sessions array, with comments stripped only outside quotes. No YAML runtime.
function withoutComment(raw) {
  let quote = null;
  for (let i = 0; i < raw.length; i++) {
    const char = raw[i];
    if (quote === '"' && char === '\\') { i++; continue; }
    if (quote && char === quote) {
      if (quote === "'" && raw[i + 1] === "'") { i++; continue; }
      quote = null;
    } else if (!quote && (char === '"' || char === "'")) quote = char;
    else if (!quote && char === '#' && (i === 0 || /\s/.test(raw[i - 1]))) return raw.slice(0, i).trim();
  }
  return raw.trim();
}

function scalar(raw) {
  const value = withoutComment(raw);
  if (value.startsWith('"')) return JSON.parse(value);
  if (value.startsWith("'")) {
    const match = /^'((?:[^']|'')*)'$/.exec(value);
    if (!match) throw new Error('Invalid scalar');
    return match[1].replace(/''/g, "'");
  }
  return value;
}

function parse(source) {
  const front = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(source);
  if (!front) throw new Error('Missing frontmatter');
  const fields = Object.create(null);
  for (const line of front[1].split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const match = /^([\w-]+):\s*(.*)$/.exec(line);
    if (!match || Object.hasOwn(fields, match[1])) throw new Error('Invalid frontmatter');
    fields[match[1]] = match[2];
  }
  if (scalar(fields.type || '') !== 'project') return null;
  const record = Object.create(null);
  for (const [key, raw] of Object.entries(fields)) {
    record[key] = key === 'sessions' ? JSON.parse(withoutComment(raw)) : scalar(raw);
  }
  if (!record.id || !record.title || !['active', 'paused', 'done'].includes(record.status)) throw new Error('Invalid project');
  for (const key of ['created', 'updated']) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(record[key]) || !Number.isFinite(Date.parse(record[key]))
      || new Date(record[key]).toISOString().slice(0, 10) !== record[key]) throw new Error('Invalid date');
  }
  if (!Object.hasOwn(record, 'sessions')) record.sessions = [];
  if (!Array.isArray(record.sessions) || record.sessions.some((session) => typeof session !== 'string')) throw new Error('Invalid sessions');
  record.private = record.private === 'true';
  return { ...record, body: source.slice(front[0].length) };
}

function clip(text, limit) {
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

function orientation(record) {
  const goal = [];
  const done = { checked: 0, total: 0 };
  const nextSteps = [];
  let section = '';
  let fence = null;
  let lastLog = '';
  for (const line of record.body.split(/\r?\n/)) {
    const marker = /^\s{0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    const inFence = !!fence || !!marker;
    if (marker) {
      if (!fence) fence = marker[1];
      else if (marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) fence = null;
    }
    const heading = !inFence && /^(#{1,2})\s+(.+?)\s*$/.exec(line);
    if (heading) { section = heading[1] === '##' ? heading[2] : ''; continue; }
    if (section === 'Goal') goal.push(line);
    if (inFence) continue;
    const checkbox = /^\s*- \[([ xX])\]\s+(.+)$/.exec(line);
    if (section === 'Definition of Done' && checkbox) {
      done.total++;
      if (checkbox[1].toLowerCase() === 'x') done.checked++;
    }
    if (section === 'Plan' && checkbox?.[1] === ' ' && nextSteps.length < 3) nextSteps.push(checkbox[2].trim());
    const bullet = section === 'Log' && /^\s*-\s+(.+)$/.exec(line);
    if (bullet && !lastLog) lastLog = clip(bullet[1].trim(), 300);
  }
  return {
    id: record.id, title: record.title, parent: record.parent || '', status: record.status,
    private: record.private, updated: record.updated, goal: clip(goal.join('\n').trim(), 400),
    done, nextSteps, lastLog,
  };
}

function unavailable() {
  return { status: 'unavailable', code: 'PROJECTS_FILES_UNAVAILABLE', reason: 'Project files are unavailable', packet: null };
}

async function readProjectsFiles(directory, { project } = {}) {
  if (project !== undefined && (typeof project !== 'string' || project.length < 1 || project.length > 200
    || /[\x00-\x1f\x7f\u0085\u2028\u2029]/.test(project))) {
    return { status: 'unavailable', code: 'PROJECTS_QUERY_UNAVAILABLE', reason: 'Projects query is unavailable', packet: null };
  }
  let root;
  let rootStat;
  let entries;
  try {
    if (typeof directory !== 'string' || !path.isAbsolute(directory)) return unavailable();
    root = await fs.realpath(directory);
    rootStat = await fs.stat(root);
    if (!rootStat.isDirectory()) return unavailable();
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch { return unavailable(); }
  // Node has no openat(), so containment is checked by identity: the opened
  // file must be the one lstat saw inside root, and root must not have been
  // swapped while reading.
  const sameRoot = async () => {
    const now = await fs.lstat(root).catch(() => null);
    return !!now && now.isDirectory() && now.dev === rootStat.dev && now.ino === rootStat.ino;
  };

  const records = [];
  const skipped = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.name.endsWith('.md')) continue;
    if (/^(readme|index)\.md$/i.test(entry.name)) {
      skipped.push({ file: entry.name, reason: 'Reserved file' });
      continue;
    }
    if (!entry.isFile()) {
      skipped.push({ file: entry.name, reason: 'Not a regular file' });
      continue;
    }
    let source;
    try {
      const filename = path.join(root, entry.name);
      if (path.dirname(await fs.realpath(filename)) !== root) throw new Error('Outside project directory');
      const before = await fs.lstat(filename);
      const handle = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const opened = await handle.stat();
        if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) throw new Error('File changed while opening');
        source = await handle.readFile('utf8');
      } finally { await handle.close(); }
      if (!(await sameRoot())) throw new Error('Project directory changed');
    } catch {
      skipped.push({ file: entry.name, reason: 'File unavailable or unsafe' });
      continue;
    }
    try {
      const record = parse(source);
      if (record) records.push(record);
      else skipped.push({ file: entry.name, reason: 'Not a project' });
    } catch {
      // Parser diagnostics can contain source text; never echo it into skipped.
      skipped.push({ file: entry.name, reason: 'Invalid project file' });
    }
  }

  if (project !== undefined) {
    const query = project.toLowerCase();
    const record = records.find((item) => item.id === project) || records.find((item) => item.title.toLowerCase() === query);
    if (!record) return {
      ok: false, status: 'not_found', code: 'PROJECT_NOT_FOUND',
      candidates: records.filter((item) => item.title.toLowerCase().includes(query)).slice(0, 5).map((item) => clip(item.title, 200)),
    };
    // Only contract fields go out, each bounded, so frontmatter can't bypass
    // the packet budget the way an unbounded custom field would.
    const fields = {};
    for (const key of ['id', 'title', 'parent', 'status', 'created', 'updated']) {
      if (typeof record[key] === 'string') fields[key] = clip(record[key], 500);
    }
    const sessions = record.sessions.slice(0, 50).map((session) => clip(session, 200));
    const result = {
      ok: true, status: 'ok', contract: CONTRACT, source: 'project-files',
      project: { ...fields, private: record.private, sessions, body: record.body.slice(0, 40_000) },
    };
    if (record.body.length > 40_000 || record.sessions.length > 50) result.truncated = true;
    while (Buffer.byteLength(JSON.stringify(result), 'utf8') > MAX_PACKET_BYTES && result.project.body) {
      result.truncated = true;
      result.project.body = result.project.body.slice(0, Math.floor(result.project.body.length * 0.8));
    }
    return result;
  }

  records.sort((a, b) => b.updated.localeCompare(a.updated) || a.title.localeCompare(b.title));
  const projects = records.slice(0, 200).map(orientation);
  const packet = {
    ok: true, status: 'ok', contract: CONTRACT, source: 'project-files', capturedAt: new Date().toISOString(),
    count: projects.length, projects, skipped,
    ...(records.length > projects.length ? { truncated: true } : {}),
  };
  const oversized = () => Buffer.byteLength(JSON.stringify(packet), 'utf8') > MAX_PACKET_BYTES;
  // Drop the oldest optional detail first. Exceptionally large identity/Plan
  // fields or skipped lists can still exceed the budget; omit tail entries then.
  for (let i = projects.length - 1; i >= 0 && oversized(); i--) {
    packet.truncated = true;
    delete projects[i].goal;
    delete projects[i].lastLog;
  }
  while (oversized() && projects.length) {
    packet.truncated = true;
    projects.pop();
    packet.count = projects.length;
  }
  while (oversized() && skipped.length) { packet.truncated = true; skipped.pop(); }
  return packet;
}

module.exports = { readProjectsFiles, parse };
