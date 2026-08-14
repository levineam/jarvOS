#!/usr/bin/env node
'use strict';

const { checkReleaseReadiness } = require('./release-readiness-check');
const { checkUnreleasedDrift } = require('./unreleased-drift-check');
const { observeReleaseStatus, parseArgs, renderHuman, gitAdapter, productionGithub, REPOSITORY } = require('./lib/release-status');

function createProductionChecks() {
  return {
    readiness: checkReleaseReadiness,
    drift: checkUnreleasedDrift,
  };
}

async function main() {
  let args;
  try {
    args = parseArgs();
  } catch (error) {
    console.error(`release:status: ${error.message}`);
    process.exitCode = 2;
    return;
  }
  let github;
  const githubAbort = new AbortController();
  try {
    const githubResponses = productionGithub(REPOSITORY, { signal: githubAbort.signal });
    const canonicalRef = args.sourceRef === 'origin/main' ? 'main' : `v${args.version}`;
    const [latestRelease, targetRelease, sourceRefSha] = await Promise.all([
      githubResponses.latestRelease(),
      githubResponses.releaseByTag(`v${args.version}`),
      githubResponses.sourceRefSha(canonicalRef),
    ]);
    github = {
      latestRelease: () => latestRelease,
      releaseByTag: () => targetRelease,
      sourceRefSha: () => sourceRefSha,
    };
  } catch (error) {
    githubAbort.abort();
    github = {
      latestRelease: () => { throw error; },
      releaseByTag: () => null,
      sourceRefSha: () => { throw error; },
    };
  }
  const result = observeReleaseStatus({
    ...args,
    git: gitAdapter(),
    github,
    checks: createProductionChecks(),
  });
  console.log(args.json ? JSON.stringify(result, null, 2) : renderHuman(result));
  process.exitCode = result.availability === 'available' ? 0 : 1;
}

if (require.main === module) main();

module.exports = { createProductionChecks };
