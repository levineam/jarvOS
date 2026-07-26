'use strict';

/**
 * @jarvos/secondbrain — Content layer
 *
 * Manages journal and notes — the raw capture surface for jarvOS agents.
 * Path resolution follows: env var → jarvos.config.json → os.homedir()-relative default.
 */

const crypto = require('crypto');
const {
  expandTilde: resolveTilde,
  getJournalDir,
  getNotesDir,
  getVaultDir,
} = require('../bridge/config/jarvos-paths.js');
const routing = require('../bridge/routing/src/keyword-capture-router.js');
const skillContracts = require('../bridge/routing/src/skill-contracts.js');
const path = require('path');

// ── Path resolution ────────────────────────────────────────────────────────

/**
 * Resolve the journal directory.
 * Priority comes from the shared jarvos-secondbrain config resolver.
 */
function resolveJournalDir() {
  return getJournalDir();
}

/**
 * Resolve the notes directory.
 * Priority comes from the shared jarvos-secondbrain config resolver.
 */
function resolveNotesDir() {
  return getNotesDir();
}

/**
 * Resolve the vault root directory.
 */
function resolveVaultDir() {
  return getVaultDir();
}

/**
 * Resolve the source-material directory. Source material is external/reference
 * content, not Andrew-authored or AI-authored durable notes.
 */
function resolveSourceMaterialDir() {
  return path.join(getVaultDir(), 'Source Material');
}

/**
 * Resolve the tags directory.
 */
function resolveTagsDir() {
  if (process.env.JARVOS_TAGS_DIR) return resolveTilde(process.env.JARVOS_TAGS_DIR);
  return path.join(getVaultDir(), 'Tags');
}

/**
 * Build a QMD collection config that indexes the full vault instead of adding
 * one-off collections for each newly discovered folder. Folder provenance stays
 * meaningful because Source Material remains under its own path inside the
 * vault, while retrieval covers the whole knowledge base.
 */
function buildQmdVaultCollectionConfig(params = {}) {
  const vaultDir = params.vaultDir || getVaultDir();
  return {
    collections: {
      vault: {
        path: vaultDir,
        pattern: params.pattern || '**/*.md',
        context: {
          '': params.context || 'Full vault content for broad knowledge-base retrieval across journals, notes, source material, projects, and references. Preserve folder-level provenance; Source Material is external content and must not be treated as user-authored or AI-authored.',
        },
      },
    },
  };
}

function sourceMaterialProvenanceErrors(frontmatter = {}) {
  const errors = [];
  const authors = Array.isArray(frontmatter.authors) ? frontmatter.authors.filter(Boolean) : [];

  if (frontmatter.authorship !== 'external') errors.push('authorship must be external');
  if (!frontmatter.source_type) errors.push('source_type is required');
  if (!frontmatter.author && authors.length === 0) errors.push('author or authors is required');
  if (!frontmatter.source_pdf && !frontmatter.canonical_url && !frontmatter.source_url) {
    errors.push('source_pdf, canonical_url, or source_url is required');
  }
  if (frontmatter.user_authored !== false) errors.push('user_authored must be false');
  if (frontmatter.ai_generated !== false) errors.push('ai_generated must be false');

  return errors;
}

function validateSourceMaterialProvenance(frontmatter = {}) {
  const errors = sourceMaterialProvenanceErrors(frontmatter);
  return { valid: errors.length === 0, errors };
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
  resolveVaultDir,
  resolveSourceMaterialDir,
  resolveTagsDir,
  resolveTilde,
  buildQmdVaultCollectionConfig,
  sourceMaterialProvenanceErrors,
  validateSourceMaterialProvenance,
  createJournalEntry,
  journalEntryPath,
  createNote,
  notePath,
  ...routing,
  ...skillContracts,
};
