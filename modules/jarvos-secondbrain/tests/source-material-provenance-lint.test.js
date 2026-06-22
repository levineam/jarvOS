const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  runLint,
  validateSourceMaterialFile,
} = require('../packages/jarvos-secondbrain-notes/src/lint-source-material');

test('accepts Source Material with explicit external provenance', () => {
  const content = `---
authorship: external
source_type: paper
authors:
  - Jane Researcher
  - Sam Scholar
original_file: jane-paper.pdf
importer: jarvis
---

# Useful Paper
`;

  assert.deepEqual(validateSourceMaterialFile('/tmp/paper.md', content), []);
});

test('flags Notes author metadata as insufficient external provenance', () => {
  const content = `---
author: jarvis
source_type: paper
authors: jarvis
authorship: external
importer: jarvis
source_url: https://example.com/paper
---

# Useful Paper
`;

  const violations = validateSourceMaterialFile('/tmp/paper.md', content);
  assert.equal(violations.some((v) => v.field === 'authors' && v.expected.includes('original source author')), true);
  assert.equal(violations.some((v) => v.field === 'original_file|original_url' && v.current.includes('source_url')), true);
});

test('summarizes Source Material provenance drift across a folder', () => {
  const sourceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'source-material-'));
  fs.writeFileSync(path.join(sourceDir, 'good.md'), `---
authorship: external
source_type: article
authors: Casey Writer
original_url: https://example.com/article
importer: andrew
---
`);
  fs.writeFileSync(path.join(sourceDir, 'bad.md'), `---
authorship: external
source_type: paper
authors: unknown
importer: jarvis
---
`);

  const result = runLint({ sourceDir });
  assert.equal(result.summary.sourceMaterialsChecked, 2);
  assert.equal(result.summary.compliant, 1);
  assert.equal(result.summary.violations, 2);
  assert.equal(result.summary.missingOriginal, 1);
  assert.equal(result.summary.ambiguousAuthors, 1);
});
