'use strict';

// The secret-scan filter regressed four times in review, each time the same way:
// a rule judged whether a safe shape appeared somewhere rather than whether every
// dangerous thing was accounted for. These cases pin both directions so the next
// rewrite has to answer them.
//
// Contract: exit 0 with output = the line survived filtering and the scan fails
// (correct for anything that could carry a credential); exit 1 = the line was
// filtered away as provably safe.
//
// No fixture is written as a literal. CI scans this file like any other, so a
// spelled-out `<key>:` or vendor prefix would make the scanner flag its own test
// data -- and a path exemption to hide that is exactly the escape hatch the filter
// refuses to offer. The pieces below are joined at runtime instead, which keeps
// the file scannable and still lets a real secret committed here be caught.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const FILTER = path.join(ROOT, 'scripts', 'filter-secret-scan-candidates.sh');
const WORKFLOW = path.join(ROOT, '.github', 'workflows', 'ci.yml');

const KEYNAME = `api${'_'}key`;
const PWNAME = `pass${''}word`;
const PRIVKEY = `private${'-'}key`;
const SK = `sk${'-'}`;
const GHP = `ghp${'_'}`;
const XOXB = `xoxb${'-'}`;
const AKIA = `AKIA${''}`;

function filter(line) {
  const result = spawnSync('bash', [FILTER], { encoding: 'utf8', input: `${line}\n` });
  return result.status === 0 ? 'reported' : 'filtered';
}

// A credential is present somewhere on the line, so the scan must still fail.
const MUST_REPORT = [
  ['bare vendor key', `+  const k = '${SK}abcdefghijklmnopqrstuvwxyz12';`],
  ['bare forge token', `+  token = '${GHP}ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';`],
  ['bare chat token', `+  t: '${XOXB}1234567890-abcdefghij'`],
  ['cloud access key id', `+  id: '${AKIA}IOSFODNN7EXAMPLE'`],
  ['private key header', '+-----BEGIN RSA PRIVATE KEY-----'],
  ['plain literal value', `+  ${KEYNAME}: 'A1b2C3d4E5f6G7h8'`],
  ['plain password', `+  ${PWNAME}: 'hunter2hunter2'`],
  // A safe shape at end of line must not excuse a credential earlier on it.
  ['credential then env fallback', `+  ${KEYNAME}: "${SK}abcdefghijklmnopqrstuvwxyz12" || process.env.OPENAI_KEY,`],
  ['credential then placeholder', `+  ${KEYNAME}: "${SK}abcdefghijklmnopqrstuvwxyz12", mode: 'test'`],
  ['password then safe second key', `+    ${PWNAME}: SuperSecret123, ${KEYNAME}: process.env.KEY,`],
  ['password then placeholder key', `src/config.js:42:    ${PWNAME}: SuperSecret123, ${KEYNAME}: "placeholder"`],
  ['empty pair beside a real key', `+  ({ A_${KEYNAME}: '', B_${KEYNAME}: '${SK}realvalue000111222333' })`],
  // A safe form must be the whole value, not merely its prefix.
  ['env reference then literal fallback', `const ${PWNAME} = process.env.PASSWORD || "SuperSecret123!"`],
  ['env reference then nullish fallback', `${KEYNAME}: process.env.API_KEY ?? "live-prod-key-abc"`],
  ['shell default expansion', `${PWNAME}=\${FOO:-SuperSecret123}`],
  ['placeholder concatenation', `${PWNAME}: "test" + "hunter2"`],
  ['empty literal concatenation', `${PWNAME}: "" + "hunter2"`],
  ['crypt hash value', `${PWNAME}: $argon2id$v=19$m=65536,t=3,p=4$c29tZXNhbHQ$RdescudvJCsgt3ub`],
  ['trailing bare variable', `+${PWNAME}=SuperSecretValue123456 $HOME`],
  // A safe assignment ends at its delimiter; what sits after it must still be
  // examined. Earlier versions skipped straight to the next secret-shaped key.
  ['vendor key after a safe assignment', `${KEYNAME}: process.env.KEY, openai: '${SK}proj-abcdefghijklmnopqrstuvwxyz'`],
  ['scoped vendor key after a safe assignment', `${KEYNAME}: process.env.KEY, k: '${SK}ant-api03-abcdefghijklmnopqrst'`],
  ['literal after a safe assignment', `const ${PWNAME} = process.env.PASSWORD, token = "SuperSecret123456"`],
  ['literal nested past a safe assignment', `foo({ bar: { ${PWNAME}: process.env.P, inner: "SuperSecret123456" } })`],
];

// Provably safe: filtering these is what keeps CI from wedging on fixtures.
const MUST_FILTER = [
  ['empty single quotes mid-line', `+    paperclip: isolatedPaperclip({ PAPERCLIP_${KEYNAME}: '', PAPERCLIP_COMPANY_ID: '' }),`],
  ['empty double quotes', `+  ${KEYNAME}: "",`],
  ['actions secret reference', `release.yml:10:  ${PRIVKEY}: \${{ secrets.APP_PRIVATE_KEY }}`],
  ['environment indirection', `+    PAPERCLIP_${KEYNAME}: process.env.PAPERCLIP_API_KEY,`],
  ['placeholder literal', `+    PAPERCLIP_${KEYNAME}: 'test-key',`],
  ['assignment to a placeholder', `+  process.env.PAPERCLIP_${KEYNAME} = 'test-key';`],
  ['two safe keys on one line', `+  ({ A_${KEYNAME}: process.env.A, B_${KEYNAME}: 'test-key' })`],
  ['braced variable reference', `+  ${PWNAME}=\${MY_PASSWORD}`],
];

test('the secret scan reports every line that could carry a credential', () => {
  for (const [name, line] of MUST_REPORT) {
    assert.equal(filter(line), 'reported', `${name}: a credential would merge silently`);
  }
});

test('the secret scan filters values that provably hold no credential', () => {
  for (const [name, line] of MUST_FILTER) {
    assert.equal(filter(line), 'filtered', `${name}: false positive would wedge CI`);
  }
});

test('neither the filter nor its fixtures match the pattern they are fed', () => {
  // Read the live pattern out of the workflow rather than copying it, so this
  // cannot drift from what CI actually greps -- and so the pattern itself is not
  // spelled out in a scanned file.
  const workflow = fs.readFileSync(WORKFLOW, 'utf8');
  const declared = workflow.match(/^\s*pattern='(.+)'$/m);
  assert.ok(declared, 'ci.yml no longer declares the secret pattern this test reads');
  for (const file of [FILTER, __filename]) {
    const hits = spawnSync('grep', ['-E', '-i', declared[1], file], { encoding: 'utf8' });
    assert.equal(hits.stdout.trim(), '', `${path.basename(file)} matches the scan pattern:\n${hits.stdout}`);
  }
});
