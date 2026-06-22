#!/usr/bin/env node
/**
 * section-config.js — single source of truth for journal section headings.
 *
 * journal-module.json's `sections.required` declares which sections exist, their
 * headings, and their order. Historically only the journal RENDERER read it; every
 * other writer (capture routing, the note↔link auditor, adapters) hardcoded the
 * headings, so renaming/reordering/disabling a section silently broke those paths.
 *
 * This resolver lets all writers resolve headings from the config (falling back to
 * the well-known defaults), so the journal format is safe to change in one place.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_SECTIONS = [
  { id: 'todays-calendar', heading: "## 📅 Today's Calendar" },
  { id: 'notes', heading: '## 📝 Notes' },
  { id: 'ideas', heading: '## 💡 Ideas' },
  { id: 'flagged', heading: '## 📌 Flagged' },
  { id: 'journal-entry', heading: '## 📓 Journal Entry' },
  { id: 'decisions', heading: '## ✅ Decisions' },
];

// Well-known default heading -> logical id, so writers that still hold a hardcoded
// default heading can be mapped onto the currently-configured heading.
const DEFAULT_HEADING_TO_ID = DEFAULT_SECTIONS.reduce((acc, s) => {
  acc[s.heading] = s.id;
  return acc;
}, {});

function defaultConfigPath() {
  return path.join(__dirname, '..', 'config', 'journal-module.json');
}

function loadSections({ configFile } = {}) {
  try {
    const raw = JSON.parse(fs.readFileSync(configFile || defaultConfigPath(), 'utf8'));
    const required = raw && raw.sections && raw.sections.required;
    if (Array.isArray(required) && required.length) {
      return required
        .filter((s) => s && s.id && s.heading)
        .map((s) => ({ id: s.id, heading: String(s.heading).trim(), enabled: s.enabled !== false }));
    }
  } catch {
    /* fall through to defaults */
  }
  return DEFAULT_SECTIONS.map((s) => ({ ...s, enabled: true }));
}

function getJournalSections(opts = {}) {
  return loadSections(opts);
}

function getSectionHeading(id, { fallback = null, ...opts } = {}) {
  const found = loadSections(opts).find((s) => s.id === id);
  return found ? found.heading : fallback;
}

function isSectionEnabled(id, opts = {}) {
  const found = loadSections(opts).find((s) => s.id === id);
  return found ? found.enabled !== false : false;
}

/**
 * Map a writer's hardcoded default heading onto the currently-configured heading for
 * the same logical section. Unknown headings pass through unchanged.
 */
function resolveConfiguredHeading(defaultHeading, opts = {}) {
  const id = DEFAULT_HEADING_TO_ID[String(defaultHeading || '').trim()];
  if (!id) return defaultHeading;
  return getSectionHeading(id, { fallback: defaultHeading, ...opts });
}

module.exports = {
  DEFAULT_SECTIONS,
  DEFAULT_HEADING_TO_ID,
  getJournalSections,
  getSectionHeading,
  isSectionEnabled,
  resolveConfiguredHeading,
  defaultConfigPath,
};
