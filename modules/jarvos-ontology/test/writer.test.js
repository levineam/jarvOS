import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { appendToSection, updateObject, addObject } from '../src/writer.js';

const TEST_DIR = join(new URL('.', import.meta.url).pathname, 'fixtures', '_writer_tmp');

describe('writer', () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });

    // Create test ontology files
    writeFileSync(join(TEST_DIR, '2-beliefs.md'), `## Beliefs
*Foundational assumptions.*

---

## B1 — Test belief
- **Status:** Active
- **Confidence:** High

### Links
- \`supports\` → Core Self Mission

— Edited by Jarvis
`);

    writeFileSync(join(TEST_DIR, '5-goals.md'), `## Goals
*Time-bound objectives.*

---

## G1 — Test goal
- **Status:** Active
- **Confidence:** Medium

### Links
- \`serves\` → Core Self Mission

— Written by Jarvis
`);
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true });
    }
  });

  describe('appendToSection', () => {
    it('appends entry before attribution line', () => {
      const result = appendToSection(TEST_DIR, 'beliefs', 'New belief detected', {
        date: '2026-03-20',
      });
      assert.ok(result.written);
      assert.ok(result.entry.includes('2026-03-20'));

      const content = readFileSync(join(TEST_DIR, '2-beliefs.md'), 'utf8');
      assert.ok(content.includes('New belief detected'));
      // Should be before the attribution line
      const entryIdx = content.indexOf('New belief detected');
      const attrIdx = content.indexOf('— Edited by Jarvis');
      assert.ok(entryIdx < attrIdx, 'entry should be before attribution');
    });

    it('supports dry-run mode', () => {
      const result = appendToSection(TEST_DIR, 'beliefs', 'Dry run test', {
        date: '2026-03-20',
        dryRun: true,
      });
      assert.ok(!result.written);

      // File should not have changed
      const content = readFileSync(join(TEST_DIR, '2-beliefs.md'), 'utf8');
      assert.ok(!content.includes('Dry run test'));
    });

    it('throws for unknown section', () => {
      assert.throws(() => appendToSection(TEST_DIR, 'nonexistent', 'test'), /Unknown section/);
    });
  });

  describe('updateObject', () => {
    it('updates metadata fields', () => {
      const result = updateObject(TEST_DIR, 'B1', { status: 'Retired', confidence: 'Low' });
      assert.ok(result.written);
      assert.deepEqual(result.updatedFields, ['status', 'confidence']);

      const content = readFileSync(join(TEST_DIR, '2-beliefs.md'), 'utf8');
      assert.ok(content.includes('**Status:** Retired'));
      assert.ok(content.includes('**Confidence:** Low'));
    });

    it('supports dry-run mode', () => {
      const result = updateObject(TEST_DIR, 'B1', { status: 'Changed' }, { dryRun: true });
      assert.ok(!result.written);

      const content = readFileSync(join(TEST_DIR, '2-beliefs.md'), 'utf8');
      assert.ok(content.includes('**Status:** Active'), 'should not have changed');
    });

    it('throws for unknown object ID', () => {
      assert.throws(() => updateObject(TEST_DIR, 'B99', { status: 'x' }), /not found/);
    });
  });

  describe('addObject', () => {
    it('adds a new object to section', () => {
      const result = addObject(TEST_DIR, 'beliefs', {
        id: 'B2',
        name: 'New test belief',
        status: 'Active',
        confidence: 'Medium',
        links: [{ type: 'supports', target: 'Core Self Mission' }],
      });
      assert.ok(result.written);

      const content = readFileSync(join(TEST_DIR, '2-beliefs.md'), 'utf8');
      assert.ok(content.includes('## B2 — New test belief'));
      assert.ok(content.includes('**Status:** Active'));
      assert.ok(content.includes('`supports` → Core Self Mission'));
    });
  });
});
