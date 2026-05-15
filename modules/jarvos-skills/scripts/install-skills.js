#!/usr/bin/env node
'use strict';

const path = require('path');
const { installSkills, validateBundle } = require('../src');

function parseArgs(argv) {
  const opts = {
    destination: '',
    force: false,
    skills: null,
    check: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if ((arg === '--dest' || arg === '--destination') && argv[i + 1]) opts.destination = argv[++i];
    else if (arg === '--force') opts.force = true;
    else if (arg === '--skill' && argv[i + 1]) {
      opts.skills = opts.skills || [];
      opts.skills.push(argv[++i]);
    } else if (arg === '--check') opts.check = true;
    else if (arg === '--help' || arg === '-h') opts.help = true;
  }

  return opts;
}

function printHelp() {
  console.log(`Usage:
  jarvos-skills --check
  jarvos-skills --dest /path/to/openclaw-workspace/skills [--force]
  jarvos-skills --dest /path/to/skills --skill workflow-execution --skill cron-hygiene

Installs the default jarvOS operating-system skill bundle:
workflow-execution, rule-creation, context-management, cron-hygiene.
QMD is intentionally not installed by default; see docs/qmd-adapter.md.`);
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    printHelp();
    return;
  }

  const validation = validateBundle();
  if (!validation.ok) {
    for (const error of validation.errors) console.error(`FAIL ${error}`);
    process.exit(1);
  }

  if (opts.check) {
    console.log(`PASS jarvos-skills bundle valid (${validation.skillCount} skills)`);
    return;
  }

  if (!opts.destination) {
    printHelp();
    process.exit(1);
  }

  const destination = path.resolve(opts.destination);
  const installed = installSkills(destination, { force: opts.force, skills: opts.skills });
  for (const item of installed) {
    console.log(`installed ${item.name} -> ${item.path}`);
  }
}

if (require.main === module) main();
