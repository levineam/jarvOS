#!/usr/bin/env node
/**
 * projects-cli.js — create, list, and sanity-check the Projects record.
 *
 *   jarvos-projects new "Ship the thing"   create a project page from the template
 *   jarvos-projects list                   show every project and its status
 *   jarvos-projects check                  report ongoing projects missing a
 *                                          Goal, plan, or Definition of Done
 *   jarvos-projects index                  regenerate index.md
 *
 * Flags:
 *   --dir <path>   override the projects directory
 *   --status <s>   status for a new project (default: active)
 *   --json         machine-readable output
 *
 * `check` exits non-zero when something is missing, so it can gate a routine.
 */

'use strict';

const path = require('node:path');
const projects = require('./projects');
const { createConfiguredVaultMutationService } = require('../../../src/vault-mutation-service');

function mutationTools(dir) {
  const shared = projects.tryResolveSharedConfig();
  const configuredVault = shared?.paths?.vault ? path.resolve(shared.paths.vault) : null;
  const resolvedDir = path.resolve(dir);
  const vaultRoot = configuredVault && (resolvedDir === configuredVault || resolvedDir.startsWith(`${configuredVault}${path.sep}`))
    ? configuredVault
    : path.dirname(resolvedDir);
  const service = createConfiguredVaultMutationService({ vaultRoot, source: 'projects.cli' });
  return {
    createMarkdownFile: (input) => service.createMarkdownFile(input),
    applyMarkdownMutation: (input) => service.applyMarkdownMutation(input),
  };
}

function parseArgs(argv) {
  const args = { command: null, rest: [], dir: null, status: null, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') args.json = true;
    else if (arg === '--dir') args.dir = argv[++i] || null;
    else if (arg.startsWith('--dir=')) args.dir = arg.slice('--dir='.length);
    else if (arg === '--status') args.status = argv[++i] || null;
    else if (arg.startsWith('--status=')) args.status = arg.slice('--status='.length);
    else if (arg === '--help' || arg === '-h') args.command = 'help';
    else if (!args.command) args.command = arg;
    else args.rest.push(arg);
  }
  return args;
}

function printHelp() {
  console.log(`jarvos-projects — the Projects record

Usage:
  jarvos-projects new "<title>" [--status active|paused|done|abandoned]
  jarvos-projects list [--json]
  jarvos-projects check [--json]
  jarvos-projects index

Options:
  --dir <path>   projects directory (default: <vault>/Projects)
  --json         machine-readable output

Every project page holds a Goal, a High-level plan, and a Definition of Done.
'check' reports ongoing projects that are missing any of them.`);
}

function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const config = projects.loadConfig();
  const dir = args.dir || projects.resolveProjectsDir(config);

  if (!args.command || args.command === 'help') {
    printHelp();
    return 0;
  }

  if (args.command === 'new') {
    const title = args.rest.join(' ').trim();
    if (!title) {
      console.error('error: a title is required — jarvos-projects new "My project"');
      return 1;
    }
    try {
      const mutations = mutationTools(dir);
      const created = projects.createProject({
        title,
        dir,
        config,
        status: args.status || undefined,
        createMarkdownFile: mutations.createMarkdownFile,
      });
      if (!created.savedLocally) projects.writeIndex({ dir, config, ...mutations });
      if (args.json) console.log(JSON.stringify(created, null, 2));
      else if (created.savedLocally) console.log(`saved locally; Sync pending: ${created.path}`);
      else {
        console.log(`created ${created.path}`);
        console.log('Fill in Goal, High-level plan, and Definition of Done.');
      }
      return 0;
    } catch (err) {
      console.error(`error: ${err.message}`);
      return 1;
    }
  }

  if (args.command === 'list') {
    const list = projects.listProjects({ dir, config });
    if (args.json) {
      console.log(JSON.stringify(list, null, 2));
      return 0;
    }
    if (!list.length) {
      console.log(`no projects in ${dir}`);
      return 0;
    }
    for (const project of list) {
      const flag = project.complete ? '' : `  (missing: ${project.missingSections.join(', ')})`;
      console.log(`${project.status.padEnd(9)} ${project.title}${flag}`);
    }
    return 0;
  }

  if (args.command === 'check') {
    const result = projects.checkProjects({ dir, config });
    if (args.json) {
      console.log(JSON.stringify(result, null, 2));
      return result.ok ? 0 : 1;
    }
    if (result.ok) {
      console.log(`ok — ${result.checked} project(s), all ongoing ones have a goal, plan, and definition of done`);
      return 0;
    }
    for (const issue of result.issues) {
      console.log(`${issue.title}: missing ${issue.missing.join(', ')}`);
    }
    return 1;
  }

  if (args.command === 'index') {
    const written = projects.writeIndex({ dir, config, ...mutationTools(dir) });
    console.log(written.savedLocally
      ? `saved locally; Sync pending: ${written.path}`
      : `wrote ${written.path} (${written.count} project(s))`);
    return 0;
  }

  console.error(`error: unknown command '${args.command}'`);
  printHelp();
  return 1;
}

if (require.main === module) {
  process.exit(main());
}

module.exports = { main, parseArgs };
