#!/usr/bin/env node
/**
 * jarvOS Bootstrap CLI
 * Usage: npx jarvos-bootstrap  OR  node bootstrap.js
 *
 * Guides a new user through setting up jarvOS on top of OpenClaw.
 */

'use strict';

const { execSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const os = require('os');

// ─── Helpers ────────────────────────────────────────────────────────────────

const GREEN  = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED    = '\x1b[31m';
const CYAN   = '\x1b[36m';
const BOLD   = '\x1b[1m';
const RESET  = '\x1b[0m';

function ok(msg)   { console.log(`${GREEN}✓${RESET} ${msg}`); }
function warn(msg) { console.log(`${YELLOW}⚠${RESET}  ${msg}`); }
function err(msg)  { console.log(`${RED}✗${RESET} ${msg}`); }
function info(msg) { console.log(`${CYAN}→${RESET} ${msg}`); }
function hdr(msg)  { console.log(`\n${BOLD}${msg}${RESET}`); }

function ask(rl, question) {
  return new Promise(resolve => rl.question(question, resolve));
}

function expandHome(p) {
  if (!p) return p;
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

// ─── Dependency checks ──────────────────────────────────────────────────────

function checkDeps() {
  hdr('1/5  Checking dependencies');

  const checks = [
    {
      name: 'Node.js ≥ 18',
      test: () => {
        const [major] = process.versions.node.split('.').map(Number);
        return major >= 18;
      },
      hint: 'Install Node.js 18+ from https://nodejs.org'
    }
  ];

  // Optional but noted
  const optionals = [
    {
      name: 'OpenClaw CLI (openclaw)',
      test: () => {
        const r = spawnSync('openclaw', ['--version'], { encoding: 'utf8' });
        return r.status === 0;
      },
      hint: 'Install with: npm install -g openclaw  (see https://openclaw.ai)'
    },
    {
      name: 'git',
      test: () => spawnSync('git', ['--version'], { encoding: 'utf8' }).status === 0
    },
    {
      name: 'npx',
      test: () => spawnSync('npx', ['--version'], { encoding: 'utf8' }).status === 0
    }
  ];

  let allOk = true;
  for (const c of checks) {
    try {
      if (c.test()) {
        ok(c.name);
      } else {
        err(`${c.name} — not found or wrong version`);
        info(c.hint);
        allOk = false;
      }
    } catch {
      err(`${c.name} — check failed`);
      if (c.hint) info(c.hint);
      allOk = false;
    }
  }

  for (const c of optionals) {
    try {
      if (c.test()) {
        ok(`${c.name} (optional)`);
      } else {
        warn(`${c.name} not found (optional)`);
        if (c.hint) info(c.hint);
      }
    } catch {
      warn(`${c.name} not found (optional)`);
      if (c.hint) info(c.hint);
    }
  }

  return allOk;
}

// ─── Prompt for config ──────────────────────────────────────────────────────

/**
 * Build config from env vars / flags without prompting.
 * Useful for CI and smoke tests.
 * Set JARVOS_YES=1 (or pass --yes) to skip prompts entirely.
 * Override individual fields with JARVOS_ASSISTANT_NAME, JARVOS_USER_NAME, etc.
 */
function nonInteractiveConfig() {
  // Detect local timezone (e.g. "America/New_York")
  let tz = 'UTC';
  try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone; } catch {}

  const defaults = {
    ASSISTANT_NAME: process.env.JARVOS_ASSISTANT_NAME || 'Jarvis',
    USER_NAME:      process.env.JARVOS_USER_NAME      || os.userInfo().username,
    COACH_NAME:     process.env.JARVOS_COACH_NAME     || 'jarvOS',
    TIMEZONE:       process.env.JARVOS_TIMEZONE       || tz,
    VAULT_PATH:     expandHome(process.env.JARVOS_VAULT_PATH      || path.join(os.homedir(), 'jarvos-vault')),
    WORKSPACE_PATH: expandHome(process.env.JARVOS_WORKSPACE_PATH  || path.join(os.homedir(), 'clawd'))
  };
  return defaults;
}

async function gatherConfig(rl) {
  hdr('2/5  Configure your jarvOS instance');

  // Non-interactive mode: --yes / -y / --non-interactive flag or JARVOS_YES env var
  const isYes =
    process.argv.includes('--yes') ||
    process.argv.includes('-y') ||
    process.argv.includes('--non-interactive') ||
    process.env.JARVOS_YES === '1';
  if (isYes) {
    const cfg = nonInteractiveConfig();
    info('Non-interactive mode — using defaults / env vars');
    info(`  ASSISTANT_NAME:  ${cfg.ASSISTANT_NAME}`);
    info(`  USER_NAME:       ${cfg.USER_NAME}`);
    info(`  COACH_NAME:      ${cfg.COACH_NAME}`);
    info(`  TIMEZONE:        ${cfg.TIMEZONE}`);
    info(`  VAULT_PATH:      ${cfg.VAULT_PATH}`);
    info(`  WORKSPACE_PATH:  ${cfg.WORKSPACE_PATH}`);
    return cfg;
  }

  const defaults = nonInteractiveConfig();

  console.log('\nPress Enter to accept the default shown in brackets.\n');

  const answers = {};
  const fields = [
    ['ASSISTANT_NAME', `Assistant name [${defaults.ASSISTANT_NAME}]: `],
    ['USER_NAME',      `Your name [${defaults.USER_NAME}]: `],
    ['COACH_NAME',     `Coach/operator name [${defaults.COACH_NAME}]: `],
    ['TIMEZONE',       `Your timezone [${defaults.TIMEZONE}]: `],
    ['VAULT_PATH',     `Vault path (Obsidian or notes folder) [${defaults.VAULT_PATH}]: `],
    ['WORKSPACE_PATH', `OpenClaw workspace path [${defaults.WORKSPACE_PATH}]: `]
  ];

  for (const [key, prompt] of fields) {
    const raw = await ask(rl, prompt);
    answers[key] = (raw || '').trim() || defaults[key];
  }

  return {
    ASSISTANT_NAME:  answers.ASSISTANT_NAME,
    USER_NAME:       answers.USER_NAME,
    COACH_NAME:      answers.COACH_NAME,
    TIMEZONE:        answers.TIMEZONE,
    VAULT_PATH:      expandHome(answers.VAULT_PATH),
    WORKSPACE_PATH:  expandHome(answers.WORKSPACE_PATH)
  };
}

// ─── Create directory structure ─────────────────────────────────────────────

function createDirectories(config) {
  hdr('3/5  Creating directory structure');

  const dirs = [
    path.join(config.VAULT_PATH, 'Notes'),
    path.join(config.VAULT_PATH, 'Journal'),
    path.join(config.VAULT_PATH, 'Tags'),
    path.join(config.WORKSPACE_PATH, 'memory')
  ];

  for (const d of dirs) {
    try {
      fs.mkdirSync(d, { recursive: true });
      ok(d);
    } catch (e) {
      err(`Failed to create ${d}: ${e.message}`);
    }
  }
}

// ─── Generate overlay files from templates ──────────────────────────────────

function renderTemplate(src, config) {
  let content = fs.readFileSync(src, 'utf8');
  // Strip HTML comment headers (template version lines)
  content = content.replace(/^<!--.*?-->\n/s, '');
  for (const [key, val] of Object.entries(config)) {
    const re = new RegExp(`\\{\\{${key}\\}\\}`, 'g');
    content = content.replace(re, val);
  }
  return content;
}

const TEMPLATE_DIR = path.join(__dirname, 'templates');

function generateOverlays(config) {
  hdr('4/5  Generating starter overlay files');

  const now = new Date();
  const today = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0')
  ].join('-');

  // Destination paths
  const ws = config.WORKSPACE_PATH;

  const overlays = [
    {
      template: path.join(TEMPLATE_DIR, 'AGENTS-template.md'),
      dest: path.join(ws, 'AGENTS.md'),
      label: 'AGENTS.md'
    },
    {
      template: path.join(TEMPLATE_DIR, 'BOOTSTRAP-template.md'),
      dest: path.join(ws, 'BOOTSTRAP.md'),
      label: 'BOOTSTRAP.md'
    },
    {
      template: path.join(TEMPLATE_DIR, 'HEARTBEAT-template.md'),
      dest: path.join(ws, 'HEARTBEAT.md'),
      label: 'HEARTBEAT.md'
    },
    {
      template: path.join(TEMPLATE_DIR, 'USER.template.md'),
      dest: path.join(ws, 'USER.md'),
      label: 'USER.md'
    },
    {
      template: path.join(TEMPLATE_DIR, 'ONTOLOGY.template.md'),
      dest: path.join(ws, 'ONTOLOGY.md'),
      label: 'ONTOLOGY.md'
    }
  ];

  for (const o of overlays) {
    if (!fs.existsSync(o.template)) {
      warn(`Template not found: ${o.template} — skipping`);
      continue;
    }
    const dest = o.dest;
    if (fs.existsSync(dest)) {
      warn(`${o.label} already exists at ${dest} — skipping (delete to regenerate)`);
      continue;
    }
    try {
      const rendered = renderTemplate(o.template, config);
      fs.writeFileSync(dest, rendered, 'utf8');
      ok(`${o.label} → ${dest}`);
    } catch (e) {
      err(`Failed to write ${o.label}: ${e.message}`);
    }
  }

  // MEMORY.md
  const memoryPath = path.join(ws, 'MEMORY.md');
  if (!fs.existsSync(memoryPath)) {
    const memContent = `# Long-Term Memory

## Identity
- I am ${config.ASSISTANT_NAME}, personal AI assistant for ${config.USER_NAME}
- Configured by ${config.COACH_NAME} via jarvOS

## Key Learnings
*(Will grow over time)*

## Important Context
*(Will grow over time)*
`;
    fs.writeFileSync(memoryPath, memContent, 'utf8');
    ok(`MEMORY.md → ${memoryPath}`);
  } else {
    warn(`MEMORY.md already exists — skipping`);
  }

  // Daily memory file
  const memDir = path.join(ws, 'memory');
  const dailyPath = path.join(memDir, `${today}.md`);
  if (!fs.existsSync(dailyPath)) {
    const dailyContent = `# Memory - ${today}

## First Run
- Bootstrap completed
- Identity: ${config.ASSISTANT_NAME} for ${config.USER_NAME}
- Coach: ${config.COACH_NAME}
`;
    fs.writeFileSync(dailyPath, dailyContent, 'utf8');
    ok(`memory/${today}.md → ${dailyPath}`);
  }

  // jarvos.config.json (only if not already present)
  const configPath = path.join(ws, 'jarvos.config.json');
  if (!fs.existsSync(configPath)) {
    const jarvosConfig = {
      assistantName: config.ASSISTANT_NAME,
      userName: config.USER_NAME,
      coachName: config.COACH_NAME,
      vaultPath: config.VAULT_PATH,
      workspacePath: config.WORKSPACE_PATH
    };
    fs.writeFileSync(configPath, JSON.stringify(jarvosConfig, null, 2) + '\n', 'utf8');
    ok(`jarvos.config.json → ${configPath}`);
  } else {
    warn(`jarvos.config.json already exists — skipping`);
  }
}

// ─── Smoke test ─────────────────────────────────────────────────────────────

function smokeTest(config) {
  hdr('5/5  Smoke test');

  const ws = config.WORKSPACE_PATH;
  const requiredFiles = ['AGENTS.md', 'BOOTSTRAP.md', 'HEARTBEAT.md', 'MEMORY.md', 'USER.md', 'ONTOLOGY.md'];
  const requiredDirs  = [
    path.join(config.VAULT_PATH, 'Notes'),
    path.join(config.VAULT_PATH, 'Journal'),
    path.join(config.VAULT_PATH, 'Tags'),
    path.join(ws, 'memory')
  ];

  let passed = 0;
  let failed = 0;

  for (const f of requiredFiles) {
    const p = path.join(ws, f);
    if (fs.existsSync(p)) { ok(`${f} present`); passed++; }
    else { err(`${f} missing at ${p}`); failed++; }
  }

  for (const d of requiredDirs) {
    if (fs.existsSync(d) && fs.statSync(d).isDirectory()) {
      ok(`dir: ${d}`);
      passed++;
    } else {
      err(`dir missing: ${d}`);
      failed++;
    }
  }

  // Template substitution check — no raw {{placeholders}} left
  for (const f of ['AGENTS.md', 'BOOTSTRAP.md']) {
    const p = path.join(ws, f);
    if (!fs.existsSync(p)) continue;
    const content = fs.readFileSync(p, 'utf8');
    const remaining = content.match(/\{\{[A-Z_]+\}\}/g);
    if (remaining) {
      warn(`${f} still has unreplaced placeholders: ${[...new Set(remaining)].join(', ')}`);
    } else {
      ok(`${f} — no unreplaced placeholders`);
      passed++;
    }
  }

  console.log('');
  if (failed === 0) {
    console.log(`${GREEN}${BOLD}All checks passed (${passed}/${passed + failed}).${RESET}`);
  } else {
    console.log(`${YELLOW}${BOLD}${passed} passed, ${failed} failed.${RESET}`);
    console.log('Review errors above and re-run bootstrap to fix.');
  }

  return failed === 0;
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n${BOLD}${CYAN}╔══════════════════════════════════════╗`);
  console.log(`║      jarvOS Bootstrap Installer      ║`);
  console.log(`╚══════════════════════════════════════╝${RESET}\n`);
  console.log('This script sets up jarvOS on top of your OpenClaw installation.');
  console.log('It will create the workspace file structure and generate starter overlay files.\n');

  const depsOk = checkDeps();
  if (!depsOk) {
    console.log(`\n${RED}Required dependencies are missing. Please install them and re-run.${RESET}\n`);
    process.exit(1);
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  let config;
  try {
    config = await gatherConfig(rl);
  } finally {
    rl.close();
  }

  createDirectories(config);
  generateOverlays(config);
  const allPassed = smokeTest(config);

  console.log(`\n${BOLD}Next steps:${RESET}`);
  console.log(`  1. Start OpenClaw:          openclaw gateway start`);
  console.log(`  2. Tell your assistant:     "Read BOOTSTRAP.md and follow its instructions"`);
  console.log(`  3. Set up your ontology:    Edit ONTOLOGY.md with your mission and goals`);
  console.log(`  4. Create your first project: Board.md + Brief.md under a Portfolio folder`);
  console.log(`\nDocs: https://github.com/levineam/jarvOS\n`);

  process.exit(allPassed ? 0 : 1);
}

main().catch(e => {
  err(`Unexpected error: ${e.message}`);
  process.exit(1);
});
