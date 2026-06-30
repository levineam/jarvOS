'use strict';

const fs = require('fs');
const path = require('path');

const EXCERPT_LEN = 220;
const SAFE_TITLE_RE = /^[^/\\:]+$/;

function listNoteFiles(notesDir) {
  return fs
    .readdirSync(notesDir)
    .filter((f) => f.endsWith('.md'))
    .map((f) => {
      const full = path.join(notesDir, f);
      const stat = fs.statSync(full);
      return { file: f, title: f.slice(0, -3), path: full, modified: stat.mtime, size: stat.size };
    })
    .sort((a, b) => b.modified - a.modified);
}

function stripMarkdown(text) {
  return text
    .replace(/^---[\s\S]*?\n---\n/, '')
    .replace(/\{[>=~+-]{2}|[<=~+-]{2}\}/g, '')
    .replace(/\{id="[^"]*"[^}]*\}/g, '')
    .replace(/[#*`>\[\]]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function excerptOf(fullPath) {
  try {
    const head = fs.readFileSync(fullPath, 'utf8').slice(0, 2000);
    return stripMarkdown(head).slice(0, EXCERPT_LEN);
  } catch {
    return '';
  }
}

function list(notesDir, { limit = 60, q = '' } = {}) {
  let files = listNoteFiles(notesDir);
  const query = q.trim().toLowerCase();
  if (query) {
    const titleHits = files.filter((f) => f.title.toLowerCase().includes(query));
    const titleSet = new Set(titleHits.map((f) => f.file));
    // Content search over the rest, capped for responsiveness.
    const contentHits = [];
    for (const f of files) {
      if (titleSet.has(f.file)) continue;
      if (contentHits.length >= limit) break;
      try {
        const text = fs.readFileSync(f.path, 'utf8');
        if (text.toLowerCase().includes(query)) contentHits.push(f);
      } catch {
        /* unreadable note — skip */
      }
    }
    files = [...titleHits, ...contentHits];
  }
  const total = files.length;
  return {
    total,
    notes: files.slice(0, limit).map((f) => ({
      title: f.title,
      modified: f.modified.toISOString(),
      size: f.size,
      excerpt: excerptOf(f.path),
    })),
  };
}

// Resolve a note by exact title, then case-insensitive, then prefix.
function resolve(notesDir, title) {
  const safeTitle = assertSafeTitle(title);
  const exact = path.join(notesDir, `${safeTitle}.md`);
  if (fs.existsSync(exact)) return exact;
  const lower = safeTitle.toLowerCase();
  const all = fs.readdirSync(notesDir).filter((f) => f.endsWith('.md'));
  const ci = all.find((f) => f.slice(0, -3).toLowerCase() === lower);
  if (ci) return path.join(notesDir, ci);
  const prefix = all.find((f) => f.slice(0, -3).toLowerCase().startsWith(lower));
  return prefix ? path.join(notesDir, prefix) : null;
}

function read(notesDir, title) {
  const file = resolve(notesDir, title);
  if (!file) return null;
  const stat = fs.statSync(file);
  return {
    title: path.basename(file, '.md'),
    content: fs.readFileSync(file, 'utf8'),
    modified: stat.mtime.toISOString(),
    path: file,
  };
}

function assertSafeTitle(title) {
  if (!title || typeof title !== 'string' || !SAFE_TITLE_RE.test(title.trim())) {
    const err = new Error('note title must be non-empty and cannot contain path separators');
    err.status = 400;
    throw err;
  }
  return title.trim();
}

function create(notesDir, title, content) {
  const safeTitle = assertSafeTitle(title);
  fs.mkdirSync(notesDir, { recursive: true });
  const file = path.join(notesDir, `${safeTitle}.md`);
  if (fs.existsSync(file)) {
    const err = new Error(`note "${safeTitle}" already exists`);
    err.status = 409;
    throw err;
  }
  const body = String(content || '').trimEnd() + '\n';
  fs.writeFileSync(file, body, { flag: 'wx', mode: 0o600 });
  const stat = fs.statSync(file);
  return { title: safeTitle, path: file, modified: stat.mtime.toISOString(), created: true };
}

function recent(notesDir, { limit = 8, sinceHours = 72 } = {}) {
  const cutoff = Date.now() - sinceHours * 3600 * 1000;
  return listNoteFiles(notesDir)
    .filter((f) => f.modified.getTime() >= cutoff)
    .slice(0, limit)
    .map((f) => ({ title: f.title, modified: f.modified.toISOString() }));
}

module.exports = { list, read, recent, create, resolve, stripMarkdown, assertSafeTitle };
