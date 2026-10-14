#!/usr/bin/env node
'use strict';

const { createHostProjectsContextProvider } = require('../src/projects-context-bootstrap');

// Local administrative entry point: binding comes from the existing trusted
// bootstrap, never from a model-supplied path, profile, scope, capability,
// or secret. Not an MCP tool and not a package bin.
async function run(argv = process.argv.slice(2), env = process.env) {
  if (argv.length !== 2 || argv[0] !== '--expected-generation' || !/^[1-9][0-9]*$/.test(argv[1])) {
    return { status: 'unavailable', code: 'PORTFOLIO_PROOF_ARGUMENTS_INVALID' };
  }
  const expectedGeneration = Number(argv[1]);
  if (!Number.isSafeInteger(expectedGeneration)) return { status: 'unavailable', code: 'PORTFOLIO_PROOF_ARGUMENTS_INVALID' };
  try {
    const provider = createHostProjectsContextProvider(env);
    if (!provider || typeof provider.readPortfolioProof !== 'function') return { status: 'unavailable', code: 'PORTFOLIO_PROOF_UNAVAILABLE' };
    return await provider.readPortfolioProof({ expectedGeneration });
  } catch {
    return { status: 'unavailable', code: 'PORTFOLIO_PROOF_UNAVAILABLE' };
  }
}

if (require.main === module) {
  run().then((result) => {
    process.stdout.write(`${JSON.stringify(result)}\n`);
    process.exitCode = result?.status === 'ok' ? 0 : result?.status === 'incomplete' ? 2 : 1;
  });
}

module.exports = { run };
