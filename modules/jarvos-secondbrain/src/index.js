'use strict';

/**
 * @jarvos/secondbrain — Content layer
 *
 * Manages journal and notes — the raw capture surface for jarvOS agents.
 * Path resolution follows: env var → jarvos.config.json → os.homedir()-relative default.
 */

const path = require('path');
const os = require('os');
const crypto = require('crypto');

// ── Path resolution ────────────────────────────────────────────────────────

function resolveTilde(p) {
  if (!p) return p;
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

/**
 * Resolve the journal directory.
 * Priority: JARVOS_JOURNAL_DIR env → default ~/Documents/Vault v3/Journal
 */
function resolveJournalDir() {
  if (process.env.JARVOS_JOURNAL_DIR) {
    return resolveTilde(process.env.JARVOS_JOURNAL_DIR);
  }
  return path.join(os.homedir(), 'Documents', 'Vault v3', 'Journal');
}

/**
 * Resolve the notes directory.
 * Priority: JARVOS_NOTES_DIR → VAULT_NOTES_DIR → default
 */
function resolveNotesDir() {
  const envDir = process.env.JARVOS_NOTES_DIR || process.env.VAULT_NOTES_DIR;
  if (envDir) return resolveTilde(envDir);
  return path.join(os.homedir(), 'Documents', 'Vault v3', 'Notes');
}

/**
 * Resolve the tags directory.
 */
function resolveTagsDir() {
  if (process.env.JARVOS_TAGS_DIR) return resolveTilde(process.env.JARVOS_TAGS_DIR);
  return path.join(os.homedir(), 'Documents', 'Vault v3', 'Tags');
}

// ── Journal ────────────────────────────────────────────────────────────────

/**
 * Create a journal entry object (does not write to disk).
 *
 * @param {object} params
 * @param {string} [params.date]  - ISO date string (defaults to today)
 * @param {string} [params.title] - Entry title
 * @param {string} [params.body]  - Entry body text
 * @param {string[]} [params.tags]- Tags
 * @returns {object} Journal entry
 */
function createJournalEntry(params = {}) {
  const now = new Date();
  const date = params.date || now.toISOString().slice(0, 10);
  const id = crypto.createHash('sha256')
    .update(`journal:${date}:${params.title || ''}:${now.toISOString()}`)
    .digest('hex')
    .slice(0, 12);

  return {
    type: 'journal-entry',
    id,
    date,
    title: String(params.title || `Journal — ${date}`),
    body: String(params.body || ''),
    tags: Array.isArray(params.tags) ? params.tags : [],
    createdAt: now.toISOString(),
  };
}

/**
 * Resolve the file path for a journal entry.
 * @param {string} date - ISO date (YYYY-MM-DD)
 * @param {string} [journalDir] - Override directory
 * @returns {string}
 */
function journalEntryPath(date, journalDir) {
  const dir = journalDir || resolveJournalDir();
  return path.join(dir, `${date}.md`);
}

// ── Notes ──────────────────────────────────────────────────────────────────

/**
 * Create a note object (does not write to disk).
 *
 * @param {object} params
 * @param {string} params.title   - Note title (becomes filename)
 * @param {string} [params.body]  - Note body
 * @param {string[]} [params.tags]- Tags
 * @returns {object} Note object
 */
function createNote(params = {}) {
  const now = new Date();
  const title = String(params.title || 'Untitled').trim();
  const id = crypto.createHash('sha256')
    .update(`note:${title}:${now.toISOString()}`)
    .digest('hex')
    .slice(0, 12);

  return {
    type: 'note',
    id,
    title,
    body: String(params.body || ''),
    tags: Array.isArray(params.tags) ? params.tags : [],
    createdAt: now.toISOString(),
  };
}

/**
 * Resolve the file path for a note.
 * @param {string} title - Note title
 * @param {string} [notesDir] - Override directory
 * @returns {string}
 */
function notePath(title, notesDir) {
  const dir = notesDir || resolveNotesDir();
  // Sanitize title for filesystem use
  const safeName = title.replace(/[/\\:*?"<>|]/g, '-');
  return path.join(dir, `${safeName}.md`);
}

module.exports = {
  resolveJournalDir,
  resolveNotesDir,
  resolveTagsDir,
  resolveTilde,
  createJournalEntry,
  journalEntryPath,
  createNote,
  notePath,
};
