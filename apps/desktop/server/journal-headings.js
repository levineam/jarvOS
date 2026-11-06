'use strict';

// Desktop is installed as a self-contained copy of apps/desktop, so it cannot
// import the secondbrain section config. This list mirrors
// headingsForSection('journal-entry') (canonical first, then legacy aliases);
// apps/desktop/test/today-journal.test.js fails if the two ever drift.
const JOURNAL_HEADINGS = Object.freeze(['## 📓 Journal', '## 📓 Journal Entry', '## Journal Entry', '## 📋 Journal Entry']);

module.exports = { JOURNAL_HEADINGS };
