'use strict';

const fs = require('node:fs');
const path = require('node:path');

function readCaptureGuideline() {
  return fs.readFileSync(path.join(__dirname, '../content/capture-guideline.md'), 'utf8')
    .replace(/^# Keeping things\r?\n/, '').trim();
}

module.exports = { readCaptureGuideline };
