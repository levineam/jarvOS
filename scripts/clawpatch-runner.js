#!/usr/bin/env node

const { existsSync } = require("node:fs");
const { join } = require("node:path");
const { spawnSync } = require("node:child_process");

if (process.env.JARVOS_DISABLE_CLAWPATCH === "1") {
  console.log("clawpatch skipped: JARVOS_DISABLE_CLAWPATCH=1");
  process.exit(0);
}

const root = join(__dirname, "..");
const localBin = join(
  root,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "clawpatch.cmd" : "clawpatch",
);

const command = existsSync(localBin) ? localBin : "clawpatch";
const result = spawnSync(command, process.argv.slice(2), {
  cwd: root,
  env: process.env,
  stdio: "inherit",
  shell: process.platform === "win32",
});

if (result.error) {
  console.error(`clawpatch failed to start: ${result.error.message}`);
  process.exit(1);
}

process.exit(result.status ?? 1);
