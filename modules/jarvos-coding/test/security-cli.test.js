'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  assertReceiptOutputOutsideVault,
  main,
  parse,
} = require('../../../scripts/jarvos-security');

test('security CLI rejects command-specific option mistakes', () => {
  assert.throws(() => parse(['setup', '--recovery']), /unsupported option for setup/);
  assert.throws(
    () => parse(['approve', '--request', 'request.json', '--output', 'receipt.json', '--typo', 'value']),
    /unsupported option for approve: --typo/,
  );
});

test('receipt output cannot overwrite the vault through direct or symlinked paths', async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'jarvos-security-output-'));
  const root = path.join(base, 'vault');
  const outside = path.join(base, 'receipts', 'approval.json');
  await fs.mkdir(root);
  assert.equal(await assertReceiptOutputOutsideVault(outside, root), outside);
  await assert.rejects(
    assertReceiptOutputOutsideVault(path.join(root, 'activation-private.pem.age'), root),
    /must be outside/,
  );

  const alias = path.join(base, 'vault-alias');
  await fs.symlink(root, alias);
  await assert.rejects(
    assertReceiptOutputOutsideVault(path.join(alias, 'activation-verifier.json'), root),
    /must be outside/,
  );
});

test('approval ceremony stops before signing unless the owner types APPROVE', async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'jarvos-security-decline-'));
  const request = path.join(base, 'request.json');
  const output = path.join(base, 'receipt.json');
  await fs.writeFile(request, JSON.stringify({ type: 'bounded-request' }));
  let issued = false;
  await assert.rejects(
    main(['approve', '--request', request, '--output', output, '--root', path.join(base, 'vault')], {
      ask: async () => 'NO',
      issueApprovedRequest: async () => { issued = true; },
      durableSecurityWrite: async () => { throw new Error('must not write'); },
    }),
    /approval not granted/,
  );
  assert.equal(issued, false);
});

test('approved recovery ceremony signs once and writes the receipt', async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'jarvos-security-approve-'));
  const requestFile = path.join(base, 'request.json');
  const output = path.join(base, 'receipt.json');
  const request = { type: 'bounded-request', scope: 'one-project' };
  await fs.writeFile(requestFile, JSON.stringify(request));
  let issueOptions;
  let written;
  assert.equal(await main([
    'approve', '--request', requestFile, '--output', output,
    '--root', path.join(base, 'vault'), '--recovery',
  ], {
    ask: async () => 'APPROVE',
    issueApprovedRequest: async (options) => {
      issueOptions = options;
      return { receipt: 'signed' };
    },
    durableSecurityWrite: async (file, contents) => { written = { file, contents }; },
  }), 0);
  assert.deepEqual(issueOptions.request, request);
  assert.equal(issueOptions.recovery, true);
  assert.equal(written.file, output);
  assert.deepEqual(JSON.parse(written.contents), { receipt: 'signed' });
});
