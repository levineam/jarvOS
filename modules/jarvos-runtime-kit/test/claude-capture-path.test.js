'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const ROOT = path.resolve(__dirname, '../../..');

test('Claude setup materializes a quoted capture path that ignores a hostile workspace', () => {
  const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-capture-path-')));
  try {
    const install = path.join(temp, "trusted install's root");
    const workspace = path.join(temp, 'workspace');
    const home = path.join(temp, 'home');
    const markdown = path.join(home, 'CLAUDE.md');
    const marker = path.join(temp, 'executed');
    for (const relative of [
      'runtimes/claude/setup.sh',
      'runtimes/claude/templates/CLAUDE.md.template',
      'modules/jarvos-instruction-projection/content/durable-orientation.md',
    ]) {
      const destination = path.join(install, relative);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.copyFileSync(path.join(ROOT, relative), destination);
    }
    for (const relative of [
      'modules/jarvos-agent-context/scripts/jarvos-mcp.js',
      'runtimes/claude/jarvos-session-start-hook.js',
      'runtimes/claude/jarvos-session-turn-hook.js',
      'runtimes/claude/jarvos-precompact-hook.js',
    ]) {
      const destination = path.join(install, relative);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.writeFileSync(destination, '// disposable registration fixture\n');
    }
    const capture = 'modules/jarvos-secondbrain/scripts/jarvos-capture.js';
    for (const [root, value] of [[install, 'trusted'], [workspace, 'workspace']]) {
      const destination = path.join(root, capture);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.writeFileSync(destination, `require('node:fs').writeFileSync(process.env.CAPTURE_TEST_MARKER, ${JSON.stringify(value)});\n`);
    }
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(markdown, '# Existing instructions\n<!-- LOCAL-EXTENSIONS-BELOW -->\nPreserve my local extension.\n');
    const env = {
      PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`, HOME: home,
      JARVOS_SKIP_CLAUDE_CODE_MCP: '1', CLAUDE_MD_PATH: markdown,
      CLAUDE_SETTINGS: path.join(home, 'settings.json'),
      CLAUDE_DESKTOP_CONFIG: path.join(home, 'desktop.json'),
      CAPTURE_TEST_MARKER: marker,
    };
    const setup = () => spawnSync('/bin/bash', [path.join(install, 'runtimes/claude/setup.sh')], { cwd: workspace, env, encoding: 'utf8' });
    const result = setup();
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const content = fs.readFileSync(markdown, 'utf8');
    assert.match(content, /Preserve my local extension\./);
    assert.doesNotMatch(content, /\{\{JARVOS_CAPTURE_SCRIPT\}\}/);
    const command = content.split('## Secondbrain Capture Rule')[1].match(/```bash\n(node [^\n]+)\n```/)[1];
    const executed = spawnSync('/bin/sh', ['-c', command], { cwd: workspace, env, encoding: 'utf8' });
    assert.equal(executed.status, 0, executed.stderr);
    assert.equal(fs.readFileSync(marker, 'utf8'), 'trusted');
    assert.equal(setup().status, 0);
    assert.equal(fs.readFileSync(markdown, 'utf8'), content);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});
