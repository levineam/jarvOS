#!/usr/bin/env node
/**
 * detect-vault.js — jarvos-secondbrain shared-vault onboarding helper.
 *
 * Resolves the shared vault configuration and verifies whether the resolved
 * vault directory exists on disk, then emits guidance for a new runtime to
 * reuse the same secondbrain vault rather than starting fresh.
 *
 * This script is the shared-vault onboarding contract owned by
 * jarvos-secondbrain. Runtime setup scripts delegate here — they do NOT
 * hard-code vault path logic themselves.
 *
 * Usage:
 *   node detect-vault.js [--runtime=hermes|openclaw] [--json]
 *
 * Exit codes:
 *   0  — vault directory exists on disk and paths are ready to use
 *   2  — paths resolved, but vault directory does not exist on disk yet
 */

'use strict';

const os = require('os');
const path = require('path');
const fs = require('fs');

// ── Path resolution (mirrors jarvos-paths.js without requiring it) ─────────

const DEFAULT_CLAWD_DIR = path.join(os.homedir(), 'clawd');
const DEFAULT_VAULT_DIR = path.join(os.homedir(), 'Documents', 'Vault v3');

function expandTilde(p) {
  if (typeof p === 'string' && p.startsWith('~/')) {
    return path.join(os.homedir(), p.slice(2));
  }
  return p;
}

function loadJarvosConfig() {
  const clawdDir = expandTilde(
    process.env.JARVOS_CLAWD_DIR || process.env.CLAWD_DIR || DEFAULT_CLAWD_DIR
  );
  const configPath = path.join(clawdDir, 'jarvos.config.json');
  let cfg = {};
  let configExists = false;
  if (fs.existsSync(configPath)) {
    configExists = true;
    try {
      cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch {
      // unparseable — treat as empty
    }
  }
  return { cfg, configPath, configExists };
}

function resolveVaultPaths() {
  const { cfg, configPath, configExists } = loadJarvosConfig();

  // Env vars take precedence over config file.
  const vault =
    expandTilde(process.env.JARVOS_VAULT_DIR) ||
    expandTilde(cfg.paths?.vault) ||
    DEFAULT_VAULT_DIR;

  const journal =
    expandTilde(process.env.JARVOS_JOURNAL_DIR) ||
    expandTilde(process.env.JOURNAL_DIR) ||
    expandTilde(cfg.paths?.journal) ||
    path.join(vault, 'Journal');

  const notes =
    expandTilde(process.env.JARVOS_NOTES_DIR) ||
    expandTilde(process.env.VAULT_NOTES_DIR) ||
    expandTilde(cfg.paths?.notes) ||
    path.join(vault, 'Notes');

  return { vault, journal, notes, configPath, configExists };
}

// ── Output helpers ──────────────────────────────────────────────────────────

function printHermesGuidance(journal, notes) {
  console.log('  To wire Hermes to this vault, set these env vars in your shell');
  console.log('  profile (~/.zshrc, ~/.bashrc, or ~/.profile) or in Hermes startup:');
  console.log('');
  console.log(`    export JARVOS_JOURNAL_DIR="${journal}"`);
  console.log(`    export JARVOS_NOTES_DIR="${notes}"`);
  console.log('');
  console.log('  jarvos-secondbrain reads these at startup — no manual path');
  console.log('  instructions are needed once they are set.');
}

function printOpenClawGuidance(configPath, configExists) {
  if (configExists) {
    console.log('  OpenClaw reads vault paths from jarvos.config.json automatically.');
    console.log(`  Config: ${configPath}`);
  } else {
    console.log('  OpenClaw reads vault paths from jarvos.config.json.');
    console.log('  No config found — copy the example to get started:');
    console.log('');
    const examplePath = path.resolve(__dirname, '../jarvos.config.example.json');
    console.log(`    cp "${examplePath}" "${configPath}"`);
    console.log('');
    console.log('  Then edit jarvos.config.json to set your vault paths.');
  }
}

function printGenericGuidance(configPath, configExists) {
  if (configExists) {
    console.log('  All jarvOS runtimes read vault paths from jarvos.config.json');
    console.log(`  (${configPath}).`);
    console.log('  New runtimes automatically share this vault — no extra setup needed.');
  } else {
    console.log('  All jarvOS runtimes read vault paths from jarvos.config.json.');
    console.log(`  Config not found at: ${configPath}`);
    console.log('');
    const examplePath = path.resolve(__dirname, '../jarvos.config.example.json');
    console.log('  To configure, copy the example:');
    console.log(`    cp "${examplePath}" "${configPath}"`);
  }
}

// ── Main ───────────────────────────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2);
  const runtimeArg = args.find((a) => a.startsWith('--runtime='));
  const runtime = runtimeArg ? runtimeArg.split('=')[1].toLowerCase() : null;
  const jsonMode = args.includes('--json');

  const { vault, journal, notes, configPath, configExists } = resolveVaultPaths();

  if (jsonMode) {
    process.stdout.write(
      JSON.stringify({ vault, journal, notes, configPath, configExists }, null, 2) + '\n'
    );
    process.exit(0);
  }

  // Header
  if (configExists) {
    console.log('  ✓ Existing secondbrain vault config found');
  } else {
    console.log('  ⚠ No jarvos.config.json found — using default vault paths');
  }
  console.log('');
  console.log(`    Vault:   ${vault}`);
  console.log(`    Journal: ${journal}`);
  console.log(`    Notes:   ${notes}`);
  console.log('');

  // Vault existence check
  const vaultExists = fs.existsSync(vault);
  if (!vaultExists) {
    console.log(`  ✗ Resolved vault directory does not exist on disk: ${vault}`);
    console.log('    Create it, or update jarvos.config.json / JARVOS_VAULT_DIR to point at your vault.');
    process.exit(2);
  }

  console.log('  ✓ Vault directory exists on disk');
  console.log('');

  // Runtime-specific guidance
  if (runtime === 'hermes') {
    printHermesGuidance(journal, notes);
  } else if (runtime === 'openclaw') {
    printOpenClawGuidance(configPath, configExists);
  } else {
    printGenericGuidance(configPath, configExists);
  }

  process.exit(0);
}

main();
