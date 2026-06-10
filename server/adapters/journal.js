'use strict';

const fs = require('fs');
const path = require('path');

const DATE_RE = /^\d{4}-\d{2}-\d{2}\.md$/;

function parseFrontmatter(text) {
  if (!text.startsWith('---')) return { frontmatter: {}, body: text };
  const end = text.indexOf('\n---', 3);
  if (end === -1) return { frontmatter: {}, body: text };
  const fmBlock = text.slice(3, end).trim();
  const body = text.slice(text.indexOf('\n', end + 1) + 1);
  const frontmatter = {};
  for (const line of fmBlock.split('\n')) {
    const m = line.match(/^([\w-]+):\s*(.*)$/);
    if (m) frontmatter[m[1]] = m[2].replace(/^"|"$/g, '');
  }
  return { frontmatter, body };
}

// Split a journal day body into its `## ` sections.
function parseSections(body) {
  const sections = [];
  let current = null;
  for (const line of body.split('\n')) {
    const h = line.match(/^##\s+(.*)$/);
    if (h) {
      if (current) sections.push(current);
      const title = h[1].trim();
      const emojiMatch = title.match(/^(\p{Extended_Pictographic}️?)\s*(.*)$/u);
      current = {
        title: emojiMatch ? emojiMatch[2] : title,
        emoji: emojiMatch ? emojiMatch[1] : '',
        lines: [],
      };
      continue;
    }
    if (current) current.lines.push(line);
  }
  if (current) sections.push(current);
  return sections.map((s) => {
    const content = s.lines.join('\n').trim();
    const items = s.lines
      .map((l) => l.match(/^\s*-\s+(.*\S)\s*$/))
      .filter(Boolean)
      .map((m) => m[1]);
    return { title: s.title, emoji: s.emoji, content, items, empty: content === '' || content === '-' };
  });
}

function readDay(journalDir, date) {
  const file = path.join(journalDir, `${date}.md`);
  if (!fs.existsSync(file)) return null;
  const raw = fs.readFileSync(file, 'utf8');
  const { frontmatter, body } = parseFrontmatter(raw);
  const stat = fs.statSync(file);
  return {
    date,
    frontmatter,
    sections: parseSections(body),
    raw,
    modified: stat.mtime.toISOString(),
  };
}

// Reverse-chronological stream of journal days.
function stream(journalDir, { limit = 14, before = null } = {}) {
  const days = fs
    .readdirSync(journalDir)
    .filter((f) => DATE_RE.test(f))
    .map((f) => f.slice(0, -3))
    .sort()
    .reverse();
  const filtered = before ? days.filter((d) => d < before) : days;
  return filtered.slice(0, limit).map((d) => readDay(journalDir, d)).filter(Boolean);
}

function today(journalDir, date) {
  return readDay(journalDir, date);
}

module.exports = { stream, today, readDay, parseSections };
