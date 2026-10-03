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

const path = require('path');
const fs = require('fs');
const {
  discoverConfigPath,
  resolveConfig,
} = require('../bridge/config/src/resolve-config');

// ── Path resolution ────────────────────────────────────────────

function resolveVaultPaths() {
  // Keep onboarding on the same fail-closed resolver used by vault mutations.
  // In particular, do not duplicate defaults or stale-vault guardrails here.
  const configPath = discoverConfigPath();
  const configExists = fs.existsSync(configPath);
  const { paths: { vault, journal, notes } } = resolveConfig();

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
  const vaultExists = fs.existsSync(vault);

  if (jsonMode) {
    if (!vaultExists) {
      console.error(`Resolved vault directory does not exist on disk: ${vault}`);
      process.exit(2);
    }
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
