'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { parseArgs } = require('../scripts/journal-health.js');

test('journal-health accepts only read-only date and JSON options', () => {
  assert.deepEqual(parseArgs(['--json', '--date=today']), { json: true, date: 'today' });
  assert.throws(() => parseArgs(['--repair']), /Unknown option/);
});
