'use strict';

// The secret-scan filter regressed three times in review, each time the same way:
// a rule judged whether a safe shape appeared somewhere rather than whether every
// dangerous thing was accounted for. These cases pin both directions so the next
// rewrite has to answer them.
//
// Contract: exit 0 with output = the line survived filtering and the scan fails
// (correct for anything that could carry a credential); exit 1 = the line was
// filtered away as provably safe.

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { spawnSync } = require('node:child_process');

const FILTER = path.join(__dirname, '..', 'scripts', 'filter-secret-scan-candidates.sh');

function filter(line) {
  const result = spawnSync('bash', [FILTER], { encoding: 'utf8', input: `${line}\n` });
  return result.status === 0 ? 'reported' : 'filtered';
}

// A credential is present somewhere on the line, so the scan must still fail.
const MUST_REPORT = [
  ['bare vendor key', "+  const k = 'sk-abcdefghijklmnopqrstuvwxyz12';"],
  ['bare forge token', "+  token = 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';"],
  ['bare chat token', "+  t: 'xoxb-1234567890-abcdefghij'"],
  ['private key header', '+-----BEGIN RSA PRIVATE KEY-----'],
  ['plain literal value', "+  api_key: 'A1b2C3d4E5f6G7h8'"],
  ['plain password', "+  password: 'hunter2hunter2'"],
  // A safe shape at end of line must not excuse a credential earlier on it.
  ['credential then env fallback', '+  api_key: "sk-abcdefghijklmnopqrstuvwxyz12" || process.env.OPENAI_API_KEY,'],
  ['credential then placeholder', '+  api_key: "sk-abcdefghijklmnopqrstuvwxyz12", mode: \'test\''],
  ['password then safe second key', '+    password: SuperSecret123, api_key: process.env.KEY,'],
  ['password then placeholder key', 'src/config.js:42:    password: SuperSecret123, api_key: "placeholder"'],
  ['empty pair beside a real key', "+  ({ A_API_KEY: '', B_API_KEY: 'sk-realvalue000111222333' })"],
  // A safe form must be the whole value, not merely its prefix.
  ['env reference then literal fallback', 'const password = process.env.PASSWORD || "SuperSecret123!"'],
  ['env reference then nullish fallback', 'api_key: process.env.API_KEY ?? "live-prod-key-abc"'],
  ['shell default expansion', 'password=${FOO:-SuperSecret123}'],
  ['placeholder concatenation', 'password: "test" + "hunter2"'],
  ['empty literal concatenation', 'password: "" + "hunter2"'],
  ['crypt hash value', 'password: $argon2id$v=19$m=65536,t=3,p=4$c29tZXNhbHQ$RdescudvJCsgt3ub'],
  ['trailing bare variable', '+password=SuperSecretValue123456 $HOME'],
];

// Provably safe: filtering these is what keeps CI from wedging on fixtures.
const MUST_FILTER = [
  ['empty single quotes mid-line', "+    paperclip: isolatedPaperclip({ PAPERCLIP_API_KEY: '', PAPERCLIP_COMPANY_ID: '' }),"],
  ['empty double quotes', '+  api_key: "",'],
  ['actions secret reference', 'release.yml:10:  private-key: ${{ secrets.APP_PRIVATE_KEY }}'],
  ['environment indirection', '+    PAPERCLIP_API_KEY: process.env.PAPERCLIP_API_KEY,'],
  ['placeholder literal', "+    PAPERCLIP_API_KEY: 'test-key',"],
  ['assignment to a placeholder', "+  process.env.PAPERCLIP_API_KEY = 'test-key';"],
  ['two safe keys on one line', "+  ({ A_API_KEY: process.env.A, B_API_KEY: 'test-key' })"],
  ['braced variable reference', '+  password=${MY_PASSWORD}'],
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

test('the filter does not match the scan pattern it feeds', () => {
  // CI greps changed lines with this pattern and pipes them here, so a literal
  // example written into the filter makes the scanner flag its own source.
  const pattern = String.raw`(ghp_|sk-[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|BEGIN (RSA|OPENSSH|EC|DSA|PRIVATE) KEY|api[_-]?key[[:space:]]*[:=]|private[_-]?key[[:space:]]*[:=]|access[_-]?token[[:space:]]*[:=]|bearer[_-]?token[[:space:]]*[:=]|password[[:space:]]*[:=]|secret[_-]?key[[:space:]]*[:=]|auth[_-]?token[[:space:]]*[:=])`;
  const hits = spawnSync('grep', ['-E', '-i', pattern, FILTER], { encoding: 'utf8' });
  assert.equal(hits.stdout.trim(), '', `filter source matches the scan pattern:\n${hits.stdout}`);
});
