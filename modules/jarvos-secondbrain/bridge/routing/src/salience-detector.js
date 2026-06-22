#!/usr/bin/env node
'use strict';

const ambientSalience = require('../../../packages/jarvos-ambient/src/intent/salience-detector');

function main() {
  let input = '';
  process.stdin.on('data', (chunk) => { input += chunk; });
  process.stdin.on('end', () => {
    const text = input.trim();
    if (!text) {
      console.error('Usage: echo "message text" | node salience-detector.js');
      process.exit(1);
    }

    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { text };
    }

    const result = ambientSalience.detectSalience(parsed);
    console.log(JSON.stringify(result, null, 2));
  });
}

module.exports = ambientSalience;

if (require.main === module) {
  main();
}
