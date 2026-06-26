const test = require('node:test');
const assert = require('node:assert/strict');

const jp = require('../bridge/config/jarvos-paths');
const linker = require('../bridge/provenance/src/link-to-journal');

const opts = { homeDir: '/home/tester', env: {} };

test('jarvos-paths shim exposes the MCP path API over resolveConfig', () => {
  assert.equal(jp.getVaultDir(opts), '/home/tester/Vaults/Vault v3');
  assert.equal(jp.getJournalDir(opts), '/home/tester/Vaults/Vault v3/Journal');
  assert.equal(jp.getNotesDir(opts), '/home/tester/Vaults/Vault v3/Notes');
  assert.equal(jp.getClawdDir(opts), '/home/tester/clawd');
});

test('jarvos-paths shim returns a valid timezone', () => {
  const tz = jp.getTimeZone(opts);
  assert.ok(typeof tz === 'string' && tz.length > 0);
  // does not throw when used as an IANA zone
  new Intl.DateTimeFormat('en-US', { timeZone: tz }).format(new Date(0));
});

test('jarvos-paths shim lets JARVOS_TIMEZONE override ambient config', () => {
  const previous = process.env.JARVOS_TIMEZONE;
  process.env.JARVOS_TIMEZONE = 'UTC';
  try {
    assert.equal(jp.getTimeZone(opts), 'UTC');
  } finally {
    if (previous === undefined) delete process.env.JARVOS_TIMEZONE;
    else process.env.JARVOS_TIMEZONE = previous;
  }
});

test('jarvos-paths shim honors an env override (so a pinned canonical vault resolves)', () => {
  const o = { homeDir: '/home/tester', env: { JARVOS_VAULT_DIR: '/abs/Vault' } };
  assert.equal(jp.getVaultDir(o), '/abs/Vault');
  assert.equal(jp.getJournalDir(o), '/abs/Vault/Journal');
});

test('link-to-journal exposes the linkNoteToJournal compat function for the MCP', () => {
  assert.equal(typeof linker.linkNoteToJournal, 'function');
  assert.equal(typeof linker.linkNoteToTodayJournal, 'function');
});
