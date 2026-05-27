#!/usr/bin/env node
'use strict';

const path = require('path');
const {
  buildInstallPlan,
  installSkills,
  listPacks,
  loadPack,
  validateBundle,
} = require('../src');

function parseArgs(argv) {
  const args = [...argv];
  const opts = {
    command: '',
    destination: '',
    force: false,
    skills: null,
    check: false,
    json: false,
    packName: 'obsidian-default',
  };

  if (args[0] && !args[0].startsWith('-')) {
    opts.command = args.shift();
  }

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--dest' || arg === '--destination') {
      if (!args[i + 1]) throw new Error(`${arg} requires a destination path`);
      opts.destination = args[++i];
    }
    else if (arg === '--force') opts.force = true;
    else if (arg === '--skill') {
      if (!args[i + 1]) throw new Error('--skill requires a skill name');
      opts.skills = opts.skills || [];
      opts.skills.push(args[++i]);
    } else if (arg === '--check') opts.check = true;
    else if (arg === '--json') opts.json = true;
    else if (arg === '--pack') {
      if (!args[i + 1]) throw new Error('--pack requires a pack name');
      opts.packName = args[++i];
    }
    else if (arg === '--help' || arg === '-h') opts.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }

  return opts;
}

function printHelp() {
  console.log(`Usage:
  jarvos-skills --check
  jarvos-skills --dest /path/to/openclaw-workspace/skills [--force]
  jarvos-skills --dest /path/to/skills --skill workflow-execution --skill cron-hygiene
  jarvos-skills list [--json]
  jarvos-skills doctor [--pack obsidian-default] [--json]
  jarvos-skills install-plan [--pack obsidian-default] [--json]

Installs the default jarvOS operating-system skill bundle:
workflow-execution, rule-creation, context-management, cron-hygiene.
QMD is intentionally not installed by default; see docs/qmd-adapter.md.

The doctor reports readiness for optional experience packs such as obsidian-default.`);
}

function printPlan(plan, json) {
  if (json) {
    process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
    return;
  }

  process.stdout.write(`${plan.pack.title} (${plan.pack.version})\n`);
  process.stdout.write(`Status: ${plan.status}\n`);
  process.stdout.write(`Source: ${plan.pack.source.repo} @ ${plan.pack.source.commit}\n\n`);
  for (const skill of plan.skills) {
    const suffix = skill.ready ? 'ready' : `missing: ${skill.missingCommands.join(', ')}`;
    process.stdout.write(`- ${skill.name}: ${suffix}\n`);
  }
  process.stdout.write('\nSetup:\n');
  for (const step of plan.setup) {
    process.stdout.write(`- ${step}\n`);
  }
}

function printError(error, json) {
  if (json) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: error.message }, null, 2)}\n`);
    return;
  }
  console.error(`ERROR ${error.message}`);
}

function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`ERROR ${error.message}`);
    process.exit(1);
  }
  if (opts.help) {
    printHelp();
    return;
  }

  if (opts.command === 'list') {
    const packs = listPacks();
    process.stdout.write(opts.json ? `${JSON.stringify(packs)}\n` : `${packs.join('\n')}\n`);
    return;
  }

  if (opts.command === 'doctor' || opts.command === 'install-plan') {
    try {
      const pack = loadPack(opts.packName);
      const plan = buildInstallPlan({ pack });
      printPlan(plan, opts.json);
      return;
    } catch (error) {
      printError(error, opts.json);
      process.exit(1);
    }
  }

  if (opts.command) {
    console.error(`ERROR Unknown command: ${opts.command}`);
    printHelp();
    process.exit(1);
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
