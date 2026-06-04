#!/usr/bin/env node
'use strict';

// jarvos-v05-profile-smoke — the v0.5.0 install proof.
//
// Given a workspace that already has the v0-5-0 skill pack installed (via
// initJarvosWorkspace), this asserts the public package can do real coding work:
// the jarvos-coding host contract exposes the session-state tools, the installed
// manifest is the v0-5-0 profile with the coding + agent-context skills, and the
// portable runTakeIssueToDone executor runs end-to-end through all stages (with
// injected mock adapters). This mirrors the live ship-gate without needing a real
// tracker/PR backend.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const coding = require('../modules/jarvos-coding/src');
const { codingHostAdapterContract } = require('../modules/jarvos-coding/src/adapters/hosts');

function parseArgs(argv = process.argv.slice(2)) {
  const options = {
    workspace: process.cwd(),
    json: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--workspace') {
      options.workspace = argv[++index];
    } else if (arg === '--json') {
      options.json = true;
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (arg) {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return options;
}

function fail(message, data, json) {
  const report = { ok: false, reason: message, ...data };
  if (json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else process.stderr.write(`FAIL: ${message}\n`);
  process.exitCode = 1;
}

function ok(message, data, json) {
  const report = { ok: true, reason: message, ...data };
  if (json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else process.stdout.write(`PASS: ${message}\n`);
}

function readInstalledSkills(workspace) {
  const manifestPath = path.resolve(workspace, '.jarvos', 'installed-skills', 'v0-5-0.json');
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`missing installed v0.5-0 manifest: ${manifestPath}`);
  }
  const raw = fs.readFileSync(manifestPath, 'utf8');
  const manifest = JSON.parse(raw);
  return { manifestPath, manifest };
}

function assertCodingContract() {
  const contract = codingHostAdapterContract('claude-code');
  const required = contract.requiredTools || [];
  if (!required.includes('jarvos_session_state.read') || !required.includes('jarvos_session_state.write')) {
    throw new Error(`unexpected jarvos-coding contract tools: ${JSON.stringify(required)}`);
  }
  return contract;
}

async function assertRunTakeIssueToDoneCallable(tempFilePath) {
  const store = coding.createFileSessionStateStore(tempFilePath);
  const result = await coding.runTakeIssueToDone({
    issueIdentifier: 'SUP-2232',
  }, {
    sessionState: store,
    tracker: {
      claimIssue: async () => ({ status: 'claimed' }),
      verifyAndClose: async () => ({ status: 'closed' }),
    },
    git: {
      createBranch: async () => ({ branch: 'SUP-2232/jarvos-v05-smoke' }),
    },
    fixer: {
      fixAndRerun: async () => ({ status: 'fixed' }),
    },
    reviewEngine: {
      sliceReview: async () => ({ status: 'pass', drives: ['runTakeIssueToDone'] }),
      holisticReview: async () => ({ status: 'pass' }),
    },
    pullRequest: {
      openPullRequest: async () => ({ status: 'opened', id: 'smoke-pr' }),
    },
    postMerge: {
      sweep: async () => ({ status: 'swept' }),
    },
  });

  if (result.status !== 'completed' || !Array.isArray(result.events) || result.events.length === 0) {
    throw new Error('runTakeIssueToDone did not complete successfully in smoke path');
  }

  return result;
}

async function main() {
  const options = parseArgs();
  if (options.help) {
    process.stdout.write('Usage: node scripts/jarvos-v05-profile-smoke.js [--workspace DIR] [--json]\n');
    return;
  }

  try {
    const contract = assertCodingContract();
    const { manifestPath, manifest } = readInstalledSkills(options.workspace);

    if (manifest.name !== 'v0-5-0') {
      throw new Error(`unexpected profile manifest: ${manifest.name || 'missing'}`);
    }

    const hasCoding = manifest.skills.some((skill) => skill.name === 'coding');
    const hasAgentContext = manifest.skills.some((skill) => skill.name === 'agent-context');
    if (!hasCoding || !hasAgentContext) {
      throw new Error('installed v0.5-0 manifest does not include coding/agent-context');
    }

    const workspace = path.resolve(options.workspace || process.cwd());
    const tempFile = path.join(os.tmpdir(), `jarvos-v05-smoke-${process.pid}.json`);
    const runTakeIssueToDoneResult = await assertRunTakeIssueToDoneCallable(tempFile);

    ok('jarvos-v05-0 profile smoke checks passed', {
      workspace,
      manifestPath,
      requiredTools: contract.requiredTools,
      runTakeIssueToDoneStatus: runTakeIssueToDoneResult.status,
      eventCount: runTakeIssueToDoneResult.events.length,
      continuityWriteback: Boolean(runTakeIssueToDoneResult.continuity),
    }, options.json);
  } catch (error) {
    fail(error.message || String(error), { workspace: options.workspace }, options.json);
  }
}

if (require.main === module) {
  void main();
}

module.exports = { main, parseArgs };
