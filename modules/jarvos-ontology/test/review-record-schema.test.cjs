'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const Ajv2020 = require('ajv/dist/2020');

const ROOT = path.resolve(__dirname, '..');

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, relativePath), 'utf8'));
}

function frontmatterObject(markdown) {
  const match = String(markdown).match(/^---\n([\s\S]*?)\n---/);
  assert.ok(match, 'template must have frontmatter');
  const out = {};
  const lines = match[1].split(/\r?\n/);
  const stack = [{ indent: -1, value: out }];

  function parseValue(value) {
    if (value === '[]') return [];
    if (value.startsWith('[')) return JSON.parse(value.replace(/'/g, '"'));
    if (/^\d+(?:\.\d+)?$/.test(value)) return Number(value);
    return value.replace(/^"|"$/g, '');
  }

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim()) continue;
    const indent = line.match(/^\s*/)[0].length;
    const trimmed = line.trim();
    const [rawKey, ...rest] = trimmed.split(':');
    const key = rawKey.trim();
    let value = rest.join(':').trim();
    while (indent <= stack[stack.length - 1].indent) {
      stack.pop();
    }
    const current = stack[stack.length - 1].value;
    if (!value) {
      const nextLine = lines.slice(index + 1).find((candidate) => candidate.trim()) || '';
      const nextIndent = nextLine.match(/^\s*/)[0].length;
      if (nextIndent > indent) {
        current[key] = {};
        stack.push({ indent, value: current[key] });
      } else {
        current[key] = null;
      }
      continue;
    }
    current[key] = parseValue(value);
  }
  return out;
}

function createAjv() {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  ajv.addFormat('date-time', {
    type: 'string',
    validate: (value) => !Number.isNaN(Date.parse(value)),
  });
  ajv.addFormat('date', {
    type: 'string',
    validate: (value) => /^\d{4}-\d{2}-\d{2}$/.test(value),
  });
  return ajv;
}

test('valid ontology candidate passes schema and source evidence is required', () => {
  const validate = createAjv().compile(readJson('schema/ontology-candidate.schema.json'));
  const candidate = {
    id: 'candidate-1',
    type: 'ontology-candidate',
    status: 'new',
    signal_type: 'belief',
    source: { type: 'CaptureEvent v2', ref: 'cap_123', quote: 'Evidence.' },
    created_at: '2026-06-25T00:00:00.000Z',
    updated_at: '2026-06-25T00:00:00.000Z',
    confidence: 0.8,
    proposed_target: 'beliefs',
    proposal: 'The user values source-backed software.',
  };

  assert.equal(validate(candidate), true, JSON.stringify(validate.errors));
  assert.equal(validate({ ...candidate, source: { type: 'note' } }), false);
  assert.match(JSON.stringify(validate.errors), /ref/);
});

test('valid inquiry links to ontology anchors, notes, Paperclip issues, and goals', () => {
  const validate = createAjv().compile(readJson('schema/inquiry-item.schema.json'));
  const inquiry = {
    id: 'inquiry-1',
    type: 'ontology-inquiry',
    status: 'new',
    question: 'What value explains this repeated preference?',
    source: { type: 'note', ref: 'Notes/Example.md' },
    owner: 'user',
    created_at: '2026-06-25T00:00:00.000Z',
    updated_at: '2026-06-25T00:00:00.000Z',
    links: {
      ontology_anchors: ['B1'],
      notes: ['Notes/Example.md'],
      paperclip_issues: ['SUP-3264'],
      beliefs: ['B1'],
      predictions: [],
      goals: ['G1'],
      projects: ['PJ1'],
    },
  };

  assert.equal(validate(inquiry), true, JSON.stringify(validate.errors));
});

test('invalid review statuses fail schema validation', () => {
  const validate = createAjv().compile(readJson('schema/ontology-candidate.schema.json'));
  const candidate = {
    id: 'candidate-1',
    type: 'ontology-candidate',
    status: 'auto-promoted',
    signal_type: 'belief',
    source: { type: 'CaptureEvent v2', ref: 'cap_123' },
    created_at: '2026-06-25T00:00:00.000Z',
    updated_at: '2026-06-25T00:00:00.000Z',
    confidence: 0.8,
    proposed_target: 'beliefs',
    proposal: 'The user values source-backed software.',
  };

  assert.equal(validate(candidate), false);
  assert.match(JSON.stringify(validate.errors), /allowedValues/);
});

test('public templates remain schema-valid examples', () => {
  const ajv = createAjv();
  const candidateValidate = ajv.compile(readJson('schema/ontology-candidate.schema.json'));
  const inquiryValidate = ajv.compile(readJson('schema/inquiry-item.schema.json'));

  const candidate = frontmatterObject(fs.readFileSync(path.join(ROOT, 'schema/templates/ontology-candidate.template.md'), 'utf8'));
  const inquiry = frontmatterObject(fs.readFileSync(path.join(ROOT, 'schema/templates/inquiry-item.template.md'), 'utf8'));

  assert.equal(candidateValidate(candidate), true, JSON.stringify(candidateValidate.errors));
  assert.equal(inquiryValidate(inquiry), true, JSON.stringify(inquiryValidate.errors));
});
