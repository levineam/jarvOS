'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { readCaptureGuideline } = require('../src');

test('capture guideline loader returns the single packaged body', () => {
  const raw = fs.readFileSync(path.join(__dirname, '../content/capture-guideline.md'), 'utf8');
  assert.equal(readCaptureGuideline(), raw.replace('# Keeping things', '').trim());
  assert.ok(require('../package.json').files.includes('content/'));
  assert.match(readCaptureGuideline(), /save only if they say yes/);
});
