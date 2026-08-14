#!/usr/bin/env node
'use strict';

const path = require('path');
const {
  buildInstallPlan,
  installSkills,
  listPacks,
  loadPack,
  planSkillProjection,
  applySkillProjection,
  validateBundle,
  statusOperator,
  planOperator,
  applyOperator,
  refreshOperator,
  shareOperator,
  enableHarness,
  disableHarness,
  renameAlias,
  repairOperator,
  schedulerOperator,
  initOperator,
  doctorSharedSkills,
  SUPPORTED_HARNESSES,
} = require('../src');

const OPERATOR_COMMANDS = new Set([
  'init-config',
  'share',
  'refresh',
  'plan',
  'apply',
  'status',
  'repair',
  'enable',
  'disable',
  'rename',
  'scheduler',
  'doctor-shared',
]);

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
    harness: 'generic',
    apply: false,
    eventRoot: '',
    projectionTrigger: '',
    configPath: '',
    id: '',
    bundlePath: '',
    scope: 'public',
    name: '',
    root: '',
    intervalMinutes: null,
    write: false,
    harnesses: null,
  };

  if (args[0] && !args[0].startsWith('-')) {
    opts.command = args.shift();
  }

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--dest' || arg === '--destination') {
      if (!args[i + 1]) throw new Error(`${arg} requires a destination path`);
      opts.destination = args[++i];
    } else if (arg === '--force') opts.force = true;
    else if (arg === '--skill') {
      if (!args[i + 1]) throw new Error('--skill requires a skill name');
      opts.skills = opts.skills || [];
      opts.skills.push(args[++i]);
    } else if (arg === '--check') opts.check = true;
    else if (arg === '--json') opts.json = true;
    else if (arg === '--pack') {
      if (!args[i + 1]) throw new Error('--pack requires a pack name');
      opts.packName = args[++i];
    } else if (arg === '--harness') {
      if (!args[i + 1]) throw new Error('--harness requires a harness name');
      opts.harness = args[++i];
    } else if (arg === '--apply') opts.apply = true;
    else if (arg === '--event-root') {
      if (!args[i + 1]) throw new Error('--event-root requires a path');
      opts.eventRoot = args[++i];
    } else if (arg === '--projection-trigger') {
      if (!args[i + 1]) throw new Error('--projection-trigger requires a path');
      opts.projectionTrigger = args[++i];
    } else if (arg === '--config') {
      if (!args[i + 1]) throw new Error('--config requires a path');
      opts.configPath = args[++i];
    } else if (arg === '--id') {
      if (!args[i + 1]) throw new Error('--id requires a skill id');
      opts.id = args[++i];
    } else if (arg === '--path') {
      if (!args[i + 1]) throw new Error('--path requires a bundle path');
      opts.bundlePath = args[++i];
    } else if (arg === '--scope') {
      if (!args[i + 1]) throw new Error('--scope requires public|local');
      opts.scope = args[++i];
    } else if (arg === '--name') {
      if (!args[i + 1]) throw new Error('--name requires an effective name');
      opts.name = args[++i];
    } else if (arg === '--root') {
      if (!args[i + 1]) throw new Error('--root requires a path');
      opts.root = args[++i];
    } else if (arg === '--interval-minutes') {
      if (!args[i + 1]) throw new Error('--interval-minutes requires an integer');
      opts.intervalMinutes = Number(args[++i]);
    } else if (arg === '--write') opts.write = true;
    else if (arg === '--harnesses') {
      if (!args[i + 1]) throw new Error('--harnesses requires a comma-separated list');
      opts.harnesses = args[++i].split(',').map((item) => item.trim()).filter(Boolean);
    } else if (arg === '--help' || arg === '-h') opts.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }

  return opts;
}

function printHelp() {
  console.log(`Usage:
  jarvos-skills --check
  jarvos-skills --dest /path/to/openclaw-workspace/skills [--force]
  jarvos-skills list [--json]
  jarvos-skills doctor [--pack obsidian-default] [--json]
  jarvos-skills install-plan [--pack obsidian-default] [--json]
  jarvos-skills projection-plan --harness hermes --dest /path/to/skills [--json]
  jarvos-skills project --harness hermes --dest /path/to/skills --apply [--json]

Shared skill distribution (catalog/overlay):
  jarvos-skills init-config [--config PATH] [--json]
  jarvos-skills share --id NAME --path /bundle --scope public|local [--harnesses a,b] [--config PATH] [--json]
  jarvos-skills refresh [--config PATH] [--json]
  jarvos-skills plan [--config PATH] [--json]
  jarvos-skills apply [--config PATH] [--json]
  jarvos-skills status [--config PATH] [--json]
  jarvos-skills repair [--config PATH] [--json]
  jarvos-skills enable --harness NAME [--root PATH] [--config PATH] [--json]
  jarvos-skills disable --harness NAME [--config PATH] [--json]
  jarvos-skills rename --id NAME --name EFFECTIVE [--config PATH] [--json]
  jarvos-skills scheduler [--write] [--interval-minutes N] [--config PATH] [--json]
  jarvos-skills doctor-shared [--config PATH] [--json]

Installs the default jarvOS operating-system skill bundle and operates the
public shared-skill catalog. Private overlay bodies never enter the package.
Live harness activation remains an owner decision.`);
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

function printResult(result, json) {
  if (json) {
    // Strip internal plan handles before serialization.
    const { _plan, ...safe } = result || {};
    process.stdout.write(`${JSON.stringify(safe, null, 2)}\n`);
    return;
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

function runOperator(opts) {
  const configPath = opts.configPath || undefined;
  switch (opts.command) {
    case 'init-config':
      return initOperator({ configPath });
    case 'share':
      return shareOperator({
        id: opts.id,
        bundlePath: opts.bundlePath,
        scope: opts.scope,
        harnesses: opts.harnesses || SUPPORTED_HARNESSES.slice(),
        configPath,
      });
    case 'refresh':
      return refreshOperator({ configPath });
    case 'plan': {
      const planned = planOperator({ configPath });
      const { _plan, ...safe } = planned;
      return safe;
    }
    case 'apply':
      return applyOperator({ configPath });
    case 'status':
      return statusOperator({ configPath });
    case 'repair':
      return repairOperator({ configPath });
    case 'enable':
      return enableHarness({ harness: opts.harness, root: opts.root || undefined, configPath });
    case 'disable':
      return disableHarness({ harness: opts.harness, configPath });
    case 'rename':
      return renameAlias({ id: opts.id, name: opts.name, configPath });
    case 'doctor-shared':
      return doctorSharedSkills({ configPath });
    case 'scheduler':
      return schedulerOperator({
        configPath,
        write: opts.write,
        intervalMinutes: opts.intervalMinutes || undefined,
      });
    default:
      throw new Error(`Unknown operator command: ${opts.command}`);
  }
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

  if (opts.command === 'projection-plan' || opts.command === 'project') {
    if (!opts.destination) {
      printError(new Error('--dest is required for skill projection'), opts.json);
      process.exit(1);
    }
    if (opts.command === 'project' && !opts.apply) {
      printError(new Error('project requires --apply; use projection-plan to inspect'), opts.json);
      process.exit(1);
    }
    try {
      const plan = planSkillProjection({
        harness: opts.harness,
        skillsRoot: path.resolve(opts.destination),
        skills: opts.skills || undefined,
      });
      const result = opts.apply ? applySkillProjection(plan) : plan;
      process.stdout.write(opts.json ? `${JSON.stringify(result, null, 2)}\n` : `${JSON.stringify(result)}\n`);
      if (!result.ok) process.exitCode = 2;
      return;
    } catch (error) {
      printError(error, opts.json);
      process.exit(1);
    }
  }

  if (OPERATOR_COMMANDS.has(opts.command)) {
    try {
      // enable/disable require a real harness id, not the legacy default.
      if ((opts.command === 'enable' || opts.command === 'disable') && !SUPPORTED_HARNESSES.includes(opts.harness)) {
        throw new Error(`--harness must be one of: ${SUPPORTED_HARNESSES.join(', ')}`);
      }
      const result = runOperator(opts);
      printResult(result, opts.json || true);
      if (result && result.ok === false) process.exitCode = 2;
      return;
    } catch (error) {
      printError(error, opts.json || true);
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
  const installed = installSkills(destination, {
    force: opts.force,
    skills: opts.skills,
    ...(opts.eventRoot ? { eventRoot: opts.eventRoot } : {}),
    ...(opts.projectionTrigger ? { projectionTrigger: opts.projectionTrigger } : {}),
  });
  for (const item of installed) {
    console.log(`installed ${item.name} -> ${item.path}`);
  }
  if (installed.event) console.log(`event ${installed.event.eventId} -> ${installed.event.path}`);
  if (installed.eventTrigger?.status === 'failed') console.error('projection trigger failed; the event remains pending for the daily safety run');
}

if (require.main === module) main();

module.exports = { parseArgs, runOperator, OPERATOR_COMMANDS };
