#!/usr/bin/env node
'use strict';

const { createHostProjectsContextProvider } = require('../src/projects-context-bootstrap');

// Local host entry point: binding comes from the existing trusted bootstrap,
// never from a model-supplied path, profile, scope, capability or limit flag.
async function run(argv = process.argv.slice(2), env = process.env) {
  const request = {};
  if (argv.length) {
    if (argv.length !== 2 || argv[0] !== '--expected-generation' || !/^(0|[1-9][0-9]*)$/.test(argv[1])) {
      return { status: 'unavailable', code: 'ROSTER_ARGUMENTS_INVALID' };
    }
    request.expectedGeneration = Number(argv[1]);
    if (!Number.isSafeInteger(request.expectedGeneration)) return { status: 'unavailable', code: 'ROSTER_ARGUMENTS_INVALID' };
  }
  try {
    const provider = createHostProjectsContextProvider(env);
    if (!provider || typeof provider.readRoster !== 'function') return { status: 'unavailable', code: 'ROSTER_UNAVAILABLE' };
    return await provider.readRoster(request);
  } catch {
    return { status: 'unavailable', code: 'ROSTER_UNAVAILABLE' };
  }
}

if (require.main === module) {
  run().then((result) => {
    process.stdout.write(`${JSON.stringify(result)}\n`);
    process.exitCode = result?.status === 'ok' ? 0 : result?.status === 'incomplete' ? 2 : 1;
  });
}

module.exports = { run };
