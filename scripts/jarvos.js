#!/usr/bin/env node
'use strict';

const { runCli } = require('../lib/jarvos-cli');

Promise.resolve(runCli())
  .then((status) => process.exit(status))
  .catch((error) => {
    process.stderr.write(`jarvos failed: ${error.message || String(error)}\n`);
    process.exit(1);
  });
