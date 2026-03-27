import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'path';
import { validate, formatValidation } from '../src/validator.js';

const ONTOLOGY_DIR = resolve(new URL('.', import.meta.url).pathname, '..', 'ontology');

describe('validator', () => {
  it('validates the canonical ontology', () => {
    const result = validate(ONTOLOGY_DIR);
    assert.ok(result.valid, 'canonical ontology should be valid (no errors)');
    assert.ok(result.objectCount > 0, 'should have objects');
    assert.ok(result.linkCount > 0, 'should have links');
  });

  it('returns structured summary', () => {
    const result = validate(ONTOLOGY_DIR);
    assert.ok('errors' in result.summary);
    assert.ok('warnings' in result.summary);
    assert.ok('infos' in result.summary);
    assert.ok('total' in result.summary);
  });

  it('produces human-readable output', () => {
    const result = validate(ONTOLOGY_DIR);
    const formatted = formatValidation(result);
    assert.ok(formatted.includes('Ontology Validation'));
    assert.ok(formatted.length > 20);
  });

  it('detects stopped projects as info', () => {
    const result = validate(ONTOLOGY_DIR);
    // PJ6 (Jotes) is Stopped
    const jotesInfo = result.issues.find(
      i => i.check === 'project-status' && i.objectId === 'PJ6'
    );
    assert.ok(jotesInfo, 'should flag PJ6 stopped status');
    assert.equal(jotesInfo.level, 'info');
  });
});
