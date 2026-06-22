#!/usr/bin/env node
/**
 * wiki-link-integrity.js — detect dangling note wiki-links in journals.
 *
 * The note<->link invariant says every `[[wiki-link]]` in a journal's notes/decisions
 * sections should resolve to a real note file in the vault Notes/ directory. This
 * auditor catches violations from ANY source (including cross-runtime drift that the
 * in-pipeline guard in three-package-router cannot see) and reports them. It is
 * report-only by default; removing/quarantining links is intentionally NOT automatic
 * because a dangling link often means the note write was lost and should be recovered,
 * not silently erased.
 *
 * Usage:
 *   node wiki-link-integrity.js                 # audit all journals (report)
 *   node wiki-link-integrity.js --date=YYYY-MM-DD
 *   node wiki-link-integrity.js --json
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { getVaultNotesDir, getVaultJournalDir } = require('./lib/provenance-config');

// Sections whose wiki-links are expected to resolve to durable notes.
const LINK_SECTIONS = ['## 📝 Notes', '## ✅ Decisions', '## 🗂️ Notes Created'];

/** Extract wiki-link targets (drops |alias and #heading) from markdown. */
function extractNoteLinks(md) {
  const out = [];
  const re = /\[\[([^\]]+)\]\]/g;
  let m;
  while ((m = re.exec(String(md || ''))) !== null) {
    const target = m[1].split('|')[0].split('#')[0].trim();
    if (target) out.push(target);
  }
  return out;
}

/** Restrict markdown to the link-bearing sections, so we don't flag links in prose. */
function linkSectionContent(md, sections = LINK_SECTIONS) {
  const lines = String(md || '').split('\n');
  const chunks = [];
  let capturing = false;
  for (const line of lines) {
    if (/^##\s/.test(line)) capturing = sections.includes(line.trim());
    else if (capturing) chunks.push(line);
  }
  return chunks.join('\n');
}

/**
 * Pure core: given a journal's markdown and a set/array of existing note titles,
 * return the de-duplicated list of wiki-link targets that have no backing note.
 */
function findDanglingLinks(journalMd, existingTitles, { sections = LINK_SECTIONS } = {}) {
  const set = existingTitles instanceof Set ? existingTitles : new Set(existingTitles || []);
  const scoped = linkSectionContent(journalMd, sections);
  const seen = new Set();
  const dangling = [];
  for (const target of extractNoteLinks(scoped)) {
    if (set.has(target) || seen.has(target)) continue;
    seen.add(target);
    dangling.push(target);
  }
  return dangling;
}

/** Build the set of existing note titles (filename without .md) from the Notes dir. */
function listNoteTitles(notesDir) {
  const titles = new Set();
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile() && e.name.endsWith('.md')) titles.add(e.name.replace(/\.md$/, ''));
    }
  };
  walk(notesDir);
  return titles;
}

/** Audit one or all journals against the vault Notes dir. */
function auditVault({ notesDir = getVaultNotesDir(), journalDir = getVaultJournalDir(), date } = {}) {
  const titles = listNoteTitles(notesDir);
  let files;
  try {
    files = fs.readdirSync(journalDir).filter((f) => f.endsWith('.md'));
  } catch {
    files = [];
  }
  if (date) files = files.filter((f) => f === `${date}.md`);

  const report = { ok: true, notesIndexed: titles.size, journalsChecked: 0, dangling: [] };
  for (const file of files) {
    let md;
    try {
      md = fs.readFileSync(path.join(journalDir, file), 'utf8');
    } catch {
      continue;
    }
    report.journalsChecked += 1;
    const dangling = findDanglingLinks(md, titles);
    if (dangling.length) {
      report.ok = false;
      report.dangling.push({ journal: file, links: dangling });
    }
  }
  return report;
}

function main(argv = process.argv.slice(2)) {
  const json = argv.includes('--json');
  const dateArg = argv.find((a) => a.startsWith('--date='));
  const date = dateArg ? dateArg.split('=')[1] : undefined;
  const report = auditVault({ date });
  if (json) {
    console.log(JSON.stringify(report, null, 2));
  } else if (report.ok) {
    console.log(`OK: no dangling note links (${report.notesIndexed} notes, ${report.journalsChecked} journals).`);
  } else {
    console.log(`DANGLING LINKS found in ${report.dangling.length} journal(s):`);
    for (const d of report.dangling) console.log(`- ${d.journal}: ${d.links.map((l) => `[[${l}]]`).join(', ')}`);
    process.exitCode = 1;
  }
}

module.exports = {
  extractNoteLinks,
  linkSectionContent,
  findDanglingLinks,
  listNoteTitles,
  auditVault,
  LINK_SECTIONS,
};

if (require.main === module) main();
