'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const SCRIPT = path.resolve(__dirname, '..', 'scripts', 'promote-reviewed.js');

test('promote-reviewed CLI refuses unreviewed candidates', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-promote-reviewed-'));
  try {
    const candidatePath = path.join(tmp, 'candidate.md');
    fs.writeFileSync(candidatePath, [
      '---',
      'id: candidate-1',
      'type: ontology-candidate',
      'status: new',
      'source:',
      '  type: CaptureEvent v2',
      '  ref: cap_1',
      'proposed_target: beliefs',
      'proposal: The user values source-backed systems.',
      '---',
      '# Candidate',
      '',
    ].join('\n'), 'utf8');

    const result = spawnSync(process.execPath, [SCRIPT, candidatePath, '--dry-run'], { encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /reviewing/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('promote-reviewed CLI emits promotion plan for reviewed candidates', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-promote-reviewed-'));
  try {
    const candidatePath = path.join(tmp, 'candidate.md');
    fs.writeFileSync(candidatePath, [
      '---',
      'id: candidate-1',
      'type: ontology-candidate',
      'status: reviewing',
      'source:',
      '  type: CaptureEvent v2',
      '  ref: cap_1',
      'reviewer: codex',
      'reviewed_at: "2026-06-25T00:00:00.000Z"',
      'proposed_target: beliefs',
      'proposal: The user values source-backed systems.',
      '---',
      '# Candidate',
      '',
    ].join('\n'), 'utf8');

    const result = spawnSync(process.execPath, [SCRIPT, candidatePath, '--dry-run'], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.dryRun, true);
    assert.equal(parsed.nextRecord.status, 'promoted');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
