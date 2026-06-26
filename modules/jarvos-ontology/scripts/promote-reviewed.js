#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const { promoteReviewedCandidate } = require('../src/review-workflow.js');

function parseScalar(value) {
  if (value === '') return null;
  if (value === '[]') return [];
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (/^\d+(?:\.\d+)?$/.test(value)) return Number(value);
  return value.replace(/^"|"$/g, '');
}

function parseFrontmatter(markdown) {
  const match = String(markdown || '').match(/^---\n([\s\S]*?)\n---/);
  if (!match) throw new Error('candidate file must start with YAML frontmatter');
  const out = {};
  const stack = [{ indent: -1, value: out }];
  const lines = match[1].split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim()) continue;
    const indent = line.match(/^\s*/)[0].length;
    const trimmed = line.trim();
    const [rawKey, ...rest] = trimmed.split(':');
    const key = rawKey.trim();
    const value = rest.join(':').trim();
    while (indent <= stack[stack.length - 1].indent) stack.pop();
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
    } else {
      current[key] = parseScalar(value);
    }
  }

  return out;
}

function main(argv = process.argv.slice(2)) {
  const candidatePath = argv.find((arg) => !arg.startsWith('--'));
  if (!candidatePath || argv.includes('--help') || argv.includes('-h')) {
    console.log('Usage: node scripts/promote-reviewed.js <candidate.md> [--dry-run]');
    return;
  }

  const abs = path.resolve(candidatePath);
  const candidate = parseFrontmatter(fs.readFileSync(abs, 'utf8'));
  const result = promoteReviewedCandidate(candidate, {
    dryRun: argv.includes('--dry-run'),
    targetAnchor: candidate.outcome?.ontology_anchor || undefined,
    reason: candidate.outcome?.reason || undefined,
  });

  if (!result.ok) {
    console.error(JSON.stringify({ ok: false, errors: result.errors }, null, 2));
    process.exitCode = 1;
    return;
  }

  console.log(JSON.stringify(result, null, 2));
}

if (require.main === module) main();

module.exports = { parseFrontmatter, main };
