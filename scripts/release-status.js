#!/usr/bin/env node
'use strict';

const { checkReleaseReadiness } = require('./release-readiness-check');
const { checkUnreleasedDrift } = require('./unreleased-drift-check');
const { approvedReleaseTags, observeReleaseStatus, parseArgs, renderHuman, gitAdapter, productionGithub, REPOSITORY } = require('./lib/release-status');

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
    const approvedTags = approvedReleaseTags(args.version);
    const canonicalRef = args.sourceRef === 'origin/main' ? 'main' : approvedTags.includes(args.sourceRef) ? args.sourceRef : approvedTags[0];
    const [latestRelease, sourceRefSha, ...taggedReleases] = await Promise.all([
      githubResponses.latestRelease(),
      githubResponses.sourceRefSha(canonicalRef),
      ...approvedTags.map((tag) => githubResponses.releaseByTag(tag)),
    ]);
    const releasesByTag = new Map(approvedTags.map((tag, index) => [tag, taggedReleases[index]]));
    github = {
      latestRelease: () => latestRelease,
      releaseByTag: (_repository, tag) => releasesByTag.get(tag) || null,
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
