#!/usr/bin/env node
'use strict';
const { capture, readInput } = require('./assignment-continuity');

async function main() {
  let input = null;
  try { input = readInput(); } catch {}
  const result = await capture(input);
  process.stdout.write(`${JSON.stringify(result.status === 'captured' ? {} : { systemMessage: 'jarvOS assignment continuity capture unavailable; no prior capture remains eligible.' })}\n`);
}
if (require.main === module) main().catch(() => process.stdout.write('{}\n'));
module.exports = { main };
