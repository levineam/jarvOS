'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const PUBLIC_METHOD_DOCS = [
  'docs/active-assistant/methodology.md',
  'docs/active-assistant/ripeness-pipeline.md',
  'templates/ONTOLOGY.template.md',
];

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

test('public Active Assistant method docs preserve the terminology contract', () => {
  const contents = PUBLIC_METHOD_DOCS.map(read).join('\n');
  for (const term of [
    'Recurrence Clustering',
    'Ripeness Scoring',
    'Support Retrieval',
    'Completion-Stage Heuristic',
    'Inactivity Signal',
    'Live Edge',
    'JITAI',
    'BCIO',
    'BCTTv1',
  ]) {
    assert.ok(contents.includes(term), `missing method term: ${term}`);
  }
  assert.match(contents, /not [“"`]Gap Analysis[,”"`]/i);
  assert.match(contents, /human-confirmed/i);
  assert.match(contents, /deterministic/i);
  assert.match(contents, /model/i);
});

test('public Active Assistant method docs contain no private deployment markers', () => {
  const forbidden = [
    ['/Users', 'andrew'].join('/'),
    ['~', 'Vaults'].join('/'),
    'active-assistant-interactions.jsonl',
    'active-assistant-note-snapshot.json',
    'SUP-3494',
    'SUP-3700',
  ];
  for (const relativePath of PUBLIC_METHOD_DOCS) {
    const contents = read(relativePath);
    for (const marker of forbidden) {
      assert.equal(contents.includes(marker), false, `${relativePath} contains private marker: ${marker}`);
    }
  }
});
