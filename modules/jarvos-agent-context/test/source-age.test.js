'use strict';

const assert = require('assert');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');

const {
  currentWork,
  recall,
  renderCurrentWorkUnavailable,
} = require('../src/index.js');
const { callTool } = require('../scripts/jarvos-mcp.js');

const NOW = '2026-08-21T12:00:00.000Z';
const STALE_AT = '2026-05-01T12:00:00.000Z';

function isolatedPaperclip(overrides = {}) {
  return {
    envFile: path.join(os.tmpdir(), 'jarvos-missing-paperclip-env'),
    PAPERCLIP_API_KEY: 'test-key',
    PAPERCLIP_COMPANY_ID: 'company-1',
    PAPERCLIP_AGENT_ID: 'agent-1',
    ...overrides,
  };
}

function withTempDir(fn) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-source-age-'));
  try {
    return fn(tmp);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function initBrainRepo(brainDir, commitDate) {
  fs.mkdirSync(brainDir, { recursive: true });
  fs.writeFileSync(path.join(brainDir, 'page.md'), 'knowledge\n');
  const gitEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: 'fixture',
    GIT_AUTHOR_EMAIL: 'fixture@example.test',
    GIT_COMMITTER_NAME: 'fixture',
    GIT_COMMITTER_EMAIL: 'fixture@example.test',
    GIT_AUTHOR_DATE: commitDate,
    GIT_COMMITTER_DATE: commitDate,
  };
  const run = (args) => {
    const result = spawnSync('git', args, { cwd: brainDir, encoding: 'utf8', env: gitEnv });
    if (result.status !== 0) {
      throw new Error(result.stderr || result.stdout || args.join(' '));
    }
  };
  run(['init']);
  run(['add', '.']);
  run(['commit', '--no-gpg-sign', '-m', 'seed', '--date', commitDate]);
}

function recallConfig(brainDir, gbrainDir, extra = {}) {
  return {
    brainDir,
    gbrainDir: gbrainDir || brainDir,
    vaultDir: brainDir,
    notesDir: brainDir,
    ...extra,
  };
}

function writeGbrainSourcesStub(dir, payload) {
  const jsonPath = path.join(dir, 'sources.json');
  const bin = path.join(dir, 'gbrain-stub');
  fs.writeFileSync(jsonPath, `${JSON.stringify(payload)}\n`);
  fs.writeFileSync(
    bin,
    `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
if (args[0] === 'sources' && args[1] === 'list') {
  process.stdout.write(fs.readFileSync(${JSON.stringify(jsonPath)}, 'utf8'));
  process.exit(0);
}
process.exit(1);
`,
    { mode: 0o755 },
  );
  fs.chmodSync(bin, 0o755);
  return bin;
}

function setDirMtime(dir, iso) {
  const at = new Date(iso);
  fs.utimesSync(dir, at, at);
}

function recallOptions(config, extra = {}) {
  return {
    query: 'who decided the recall contract',
    dryRun: true,
    includeQmd: false,
    autoGraph: false,
    now: NOW,
    config,
    ...extra,
  };
}

async function withMockedFetch(payload, fn) {
  const oldFetch = global.fetch;
  global.fetch = async () => {
    if (typeof payload === 'function') return payload();
    return { ok: true, json: async () => payload };
  };
  try {
    return await fn();
  } finally {
    global.fetch = oldFetch;
  }
}

test('recall labels source last-commit age from the GBrain repo', () => {
  withTempDir((tmp) => {
    const brainDir = path.join(tmp, 'brain');
    initBrainRepo(brainDir, STALE_AT);
    const result = recall(recallOptions(recallConfig(brainDir)));
    assert.match(result.markdown, /^# jarvOS Recall Bundle\n\nbrain age: last commit 2026-05-01 \(112d ago\); last sync unknown\n/);
    const truncated = result.markdown.slice(0, 96);
    assert.match(truncated, /brain age: last commit 2026-05-01 \(112d ago\)/);
  });
});

test('recall labels last-modified age when git metadata is absent', () => {
  withTempDir((tmp) => {
    const brainDir = path.join(tmp, 'brain');
    fs.mkdirSync(brainDir, { recursive: true });
    fs.writeFileSync(path.join(brainDir, 'page.md'), 'knowledge\n');
    const at = new Date(STALE_AT);
    fs.utimesSync(brainDir, at, at);
    const result = recall(recallOptions(recallConfig(brainDir)));
    assert.match(result.markdown, /brain age: last modified 2026-05-01 \(112d ago\); last sync unknown/);
  });
});

test('recall includes last-sync age when a sync marker is reachable', () => {
  withTempDir((tmp) => {
    const brainDir = path.join(tmp, 'brain');
    const gbrainDir = path.join(tmp, 'gbrain');
    fs.mkdirSync(brainDir, { recursive: true });
    fs.mkdirSync(gbrainDir, { recursive: true });
    const marker = path.join(gbrainDir, 'last-sync');
    fs.writeFileSync(marker, 'ok\n');
    const at = new Date('2026-08-21T11:00:00.000Z');
    fs.utimesSync(marker, at, at);
    const result = recall(recallOptions(recallConfig(brainDir, gbrainDir)));
    assert.match(result.markdown, /brain age: last modified .*?; last sync 2026-08-21 \(1h ago\)/);
  });
});

test('recall labels unknown brain age when the source cannot be observed', () => {
  withTempDir((tmp) => {
    const missing = path.join(tmp, 'missing-brain');
    const result = recall(recallOptions(recallConfig(missing)));
    assert.match(result.markdown, /^# jarvOS Recall Bundle\n\nbrain age: unknown\n/);
    assert.doesNotMatch(result.markdown, /brain age: unknown\nbrain age:/);
  });
});

test('a single GBrain source keeps the current provenance line byte-identical', () => {
  withTempDir((tmp) => {
    const brainDir = path.join(tmp, 'brain');
    initBrainRepo(brainDir, STALE_AT);
    const config = recallConfig(brainDir);
    const expected = '# jarvOS Recall Bundle\n\nbrain age: last commit 2026-05-01 (112d ago); last sync unknown\n';
    const without = recall(recallOptions(config));
    const withList = recall(recallOptions(config, {
      brainSources: [{ id: 'default', local_path: brainDir, last_sync_at: '2026-08-21T11:00:00.000Z' }],
    }));
    assert.equal(without.markdown.slice(0, expected.length), expected);
    assert.equal(withList.markdown, without.markdown);
  });
});

test('recall labels both GBrain sources when their ages differ', () => {
  withTempDir((tmp) => {
    const brainDir = path.join(tmp, 'brain');
    const vaultDir = path.join(tmp, 'vault');
    initBrainRepo(brainDir, STALE_AT);
    fs.mkdirSync(vaultDir, { recursive: true });
    fs.writeFileSync(path.join(vaultDir, 'note.md'), 'live\n');
    setDirMtime(vaultDir, '2026-08-21T11:00:00.000Z');
    const result = recall(recallOptions(recallConfig(brainDir), {
      brainSources: [
        { id: 'default', local_path: brainDir },
        { id: 'vault', local_path: vaultDir },
      ],
    }));
    assert.match(
      result.markdown,
      /^# jarvOS Recall Bundle\n\nbrain age: default last commit 2026-05-01 \(112d ago\); vault last modified 2026-08-21 \(1h ago\); last sync unknown\n/,
    );
    assert.equal(result.markdown.includes(tmp), false);
  });
});

test('recall marks a listed source whose git probe fails, never as last modified', () => {
  withTempDir((tmp) => {
    const brainDir = path.join(tmp, 'brain');
    initBrainRepo(brainDir, STALE_AT);
    // A git toplevel with no commits: `git log -1` exits non-zero, which is the
    // same observation a timeout produces. Sync bumps mtime, so without the
    // failure flag this source would read as freshly "last modified" while its
    // real commit age is unknown -- the provenance lie the single-source path
    // already closed.
    const probeFails = path.join(tmp, 'probe-fails');
    fs.mkdirSync(probeFails, { recursive: true });
    fs.writeFileSync(path.join(probeFails, 'note.md'), 'live\n');
    spawnSync('git', ['-C', probeFails, 'init', '--quiet'], { stdio: 'ignore' });
    setDirMtime(probeFails, '2026-08-21T11:00:00.000Z');
    const result = recall(recallOptions(recallConfig(brainDir), {
      brainSources: [
        { id: 'default', local_path: brainDir },
        { id: 'vault', local_path: probeFails },
      ],
    }));
    assert.match(result.markdown, /vault last modified \(commit age unavailable\) 2026-08-21 \(1h ago\)/);
    // The bare wording is what a successful probe produces; it must not appear
    // for a source whose commit age was never actually read.
    assert.doesNotMatch(result.markdown, /vault last modified 2026-08-21/);
    assert.equal(result.markdown.includes(tmp), false);
  });
});

test('recall keeps other sources when one GBrain source age is unknown', () => {
  withTempDir((tmp) => {
    const brainDir = path.join(tmp, 'brain');
    initBrainRepo(brainDir, STALE_AT);
    const result = recall(recallOptions(recallConfig(brainDir), {
      brainSources: [
        { id: 'default', local_path: brainDir },
        { id: 'vault', local_path: path.join(tmp, 'missing-vault') },
      ],
    }));
    assert.match(
      result.markdown,
      /^# jarvOS Recall Bundle\n\nbrain age: default last commit 2026-05-01 \(112d ago\); vault unknown; last sync unknown\n/,
    );
  });
});

test('recall falls back to the configured path when the GBrain source list is unavailable', () => {
  withTempDir((tmp) => {
    const brainDir = path.join(tmp, 'brain');
    initBrainRepo(brainDir, STALE_AT);
    const expected = /^# jarvOS Recall Bundle\n\nbrain age: last commit 2026-05-01 \(112d ago\); last sync unknown\n/;
    const missingBin = recall(recallOptions(recallConfig(brainDir, brainDir, {
      gbrainBin: path.join(tmp, 'missing-gbrain'),
    })));
    assert.match(missingBin.markdown, expected);
    const thrown = recall(recallOptions(recallConfig(brainDir), {
      listBrainSources: () => {
        throw new Error('source list unavailable');
      },
    }));
    assert.match(thrown.markdown, expected);
  });
});

test('multi-source brain age sits under the heading so truncation cannot drop it', () => {
  withTempDir((tmp) => {
    const brainDir = path.join(tmp, 'brain');
    const vaultDir = path.join(tmp, 'vault');
    initBrainRepo(brainDir, STALE_AT);
    fs.mkdirSync(vaultDir, { recursive: true });
    fs.writeFileSync(path.join(vaultDir, 'note.md'), 'live\n');
    setDirMtime(vaultDir, '2026-08-21T11:00:00.000Z');
    const result = recall(recallOptions(recallConfig(brainDir), {
      brainSources: [
        { id: 'default', local_path: brainDir },
        { id: 'vault', local_path: vaultDir },
      ],
    }));
    const truncated = result.markdown.slice(0, 120);
    assert.match(truncated, /^# jarvOS Recall Bundle\n\nbrain age: default last commit 2026-05-01 \(112d ago\); vault last modified/);
    assert.match(result.markdown.slice(0, 80), /brain age:/);
  });
});

test('recall reads multiple sources from gbrain sources list --json', () => {
  withTempDir((tmp) => {
    const brainDir = path.join(tmp, 'brain');
    const vaultDir = path.join(tmp, 'vault');
    const gbrainDir = path.join(tmp, 'gbrain');
    fs.mkdirSync(gbrainDir, { recursive: true });
    initBrainRepo(brainDir, STALE_AT);
    fs.mkdirSync(vaultDir, { recursive: true });
    fs.writeFileSync(path.join(vaultDir, 'note.md'), 'live\n');
    setDirMtime(vaultDir, '2026-08-21T11:00:00.000Z');
    const gbrainBin = writeGbrainSourcesStub(gbrainDir, {
      sources: [
        { id: 'default', local_path: brainDir, last_sync_at: null },
        { id: 'vault', local_path: vaultDir, last_sync_at: '2026-08-21T11:00:00.000Z' },
      ],
    });
    const result = recall(recallOptions(recallConfig(brainDir, gbrainDir, { gbrainBin })));
    assert.match(
      result.markdown,
      /^# jarvOS Recall Bundle\n\nbrain age: default last commit 2026-05-01 \(112d ago\); vault last modified 2026-08-21 \(1h ago\)\nlast sync: default unknown, vault 2026-08-21 \(1h ago\)\n/,
    );
    assert.equal(result.markdown.includes(brainDir), false);
    assert.equal(result.markdown.includes(vaultDir), false);
  });
});

test('recall summarises many GBrain sources and names the oldest', () => {
  withTempDir((tmp) => {
    const brainDir = path.join(tmp, 'brain');
    const vaultDir = path.join(tmp, 'vault');
    const wikiDir = path.join(tmp, 'wiki');
    initBrainRepo(brainDir, STALE_AT);
    initBrainRepo(wikiDir, '2026-01-01T12:00:00.000Z');
    fs.mkdirSync(vaultDir, { recursive: true });
    fs.writeFileSync(path.join(vaultDir, 'note.md'), 'live\n');
    setDirMtime(vaultDir, '2026-08-21T11:00:00.000Z');
    const result = recall(recallOptions(recallConfig(brainDir), {
      brainSources: [
        { id: 'default', local_path: brainDir },
        { id: 'vault', local_path: vaultDir },
        { id: 'wiki', local_path: wikiDir },
      ],
    }));
    assert.match(
      result.markdown,
      /^# jarvOS Recall Bundle\n\nbrain age: 3 sources, newest vault 1h ago, oldest wiki last commit 2026-01-01 \(232d ago\); last sync unknown\n/,
    );
  });
});

test('currentWork labels a recently reconciled source as fresh', async () => {
  await withMockedFetch({
    capturedAt: NOW,
    items: [{ identifier: 'WORK-1', status: 'in_progress', title: 'Active work', assigneeAgentId: 'agent-1' }],
  }, async () => {
    const result = await currentWork({
      paperclip: isolatedPaperclip(),
      now: NOW,
      maxItems: 8,
    });
    assert.equal(result.ok, true);
    assert.match(result.markdown, /^# jarvOS Current Work\n\nfresh as of 2026-08-21T12:00:00.000Z\n/);
    assert.match(result.markdown, /WORK-1/);
    assert.match(result.markdown.slice(0, 72), /fresh as of 2026-08-21T12:00:00.000Z/);
  });
});

test('currentWork returns stale work labelled with its age', async () => {
  await withMockedFetch({
    capturedAt: STALE_AT,
    items: [{ identifier: 'WORK-9', status: 'in_progress', title: 'Old but real work', assigneeAgentId: 'agent-1' }],
  }, async () => {
    const result = await currentWork({
      paperclip: isolatedPaperclip(),
      now: NOW,
      maxItems: 8,
    });
    assert.equal(result.ok, true);
    assert.match(result.markdown, /^# jarvOS Current Work\n\nstale \(age 112d\): last reconciled 2026-05-01T12:00:00.000Z\n/);
    assert.match(result.markdown, /WORK-9/);
    assert.match(result.markdown.slice(0, 88), /stale \(age 112d\)/);
  });
});

test('currentWork labels unknown age when the source timestamp cannot be parsed', async () => {
  await withMockedFetch({
    capturedAt: 'not-a-timestamp',
    items: [{ identifier: 'WORK-3', status: 'in_progress', title: 'Work with unknown age', assigneeAgentId: 'agent-1' }],
  }, async () => {
    const result = await currentWork({
      paperclip: isolatedPaperclip(),
      now: NOW,
      reconciledAt: 'not-a-timestamp',
      maxItems: 8,
    });
    assert.equal(result.ok, true);
    assert.match(result.markdown, /^# jarvOS Current Work\n\nsource age: unknown\n/);
    assert.match(result.markdown, /WORK-3/);
  });
});

test('currentWork says unavailable instead of returning an empty work list', async () => {
  const result = await currentWork({
    paperclip: isolatedPaperclip({ PAPERCLIP_API_KEY: '', PAPERCLIP_COMPANY_ID: '' }),
    now: NOW,
  });
  assert.equal(result.ok, false);
  assert.equal(result.markdown, renderCurrentWorkUnavailable());
  assert.match(result.markdown, /source: unavailable/);
  assert.doesNotMatch(result.markdown, /No active Paperclip issues found/);
  assert.deepEqual(result.issues, []);
});

test('MCP jarvos_current_work keeps unavailable explicit when the source throws', async () => {
  const oldFetch = global.fetch;
  const oldEnv = {
    PAPERCLIP_API_KEY: process.env.PAPERCLIP_API_KEY,
    PAPERCLIP_COMPANY_ID: process.env.PAPERCLIP_COMPANY_ID,
    PAPERCLIP_AGENT_ID: process.env.PAPERCLIP_AGENT_ID,
    JARVOS_PAPERCLIP_ENV_FILE: process.env.JARVOS_PAPERCLIP_ENV_FILE,
  };
  process.env.PAPERCLIP_API_KEY = 'test-key';
  process.env.PAPERCLIP_COMPANY_ID = 'company-1';
  process.env.PAPERCLIP_AGENT_ID = 'agent-1';
  process.env.JARVOS_PAPERCLIP_ENV_FILE = path.join(os.tmpdir(), 'jarvos-missing-paperclip-env');
  global.fetch = async () => {
    throw new Error('Paperclip is unreachable');
  };
  try {
    const result = await callTool('jarvos_current_work', { maxItems: 4 });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /source: unavailable/);
    assert.doesNotMatch(result.content[0].text, /No active Paperclip issues found/);
    assert.doesNotMatch(result.content[0].text, /^\[\]$/);
  } finally {
    global.fetch = oldFetch;
    for (const [key, value] of Object.entries(oldEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
