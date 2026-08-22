'use strict';

// Host entry for jarvos_todo_* MCP tools.
//
// The MCP loader only accepts an owner-only regular file contained under the
// workspaceRoot from JARVOS_PROJECTS_CONTEXT_CONFIG. Copy this file into that
// workspace and point JARVOS_WORK_ACTION_SERVICE_MODULE at the copy. This
// public tree cannot ship a live binding: a module kept here would fail the
// containment check for any host whose Projects workspace is outside the
// clone.
//
// Beads location is host-resolved from the Projects context config
// (`beadsWorkspace`, else `workspaceRoot`). Do not hardcode a machine path.

const fs = require('node:fs');
const path = require('node:path');

function resolveCodingModule() {
  const explicit = process.env.JARVOS_CODING_MODULE;
  if (typeof explicit === 'string' && explicit.trim()) return explicit.trim();
  const parentFile = module.parent && module.parent.filename;
  if (typeof parentFile === 'string') {
    const fromMcp = [
      path.resolve(path.dirname(parentFile), '..', '..', 'jarvos-coding', 'src', 'index.js'),
      path.resolve(path.dirname(parentFile), '..', '..', 'coding', 'src', 'index.js'),
    ];
    for (const candidate of fromMcp) {
      try {
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch {
        // Keep looking; the packaged name is a fallback.
      }
    }
  }
  return '@jarvos/coding';
}

function absolutePath(value) {
  return typeof value === 'string' && path.isAbsolute(value) ? value : null;
}

function readHostOptions() {
  const configPath = process.env.JARVOS_PROJECTS_CONTEXT_CONFIG;
  if (!absolutePath(configPath)) {
    throw new Error('JARVOS_PROJECTS_CONTEXT_CONFIG must be an absolute path');
  }
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('Projects context config is invalid');
  }
  const workspaceRoot = absolutePath(config.workspaceRoot);
  if (!workspaceRoot) throw new Error('Projects context workspaceRoot must be an absolute path');
  const beadsWorkspace = absolutePath(config.beadsWorkspace) || workspaceRoot;
  const approvedWorkspaceIds = Array.isArray(config.approvedWorkspaceIds) && config.approvedWorkspaceIds.length > 0
    ? config.approvedWorkspaceIds
    : [workspaceRoot, beadsWorkspace];
  const operationStoreRoot = absolutePath(config.workActionOperationStoreRoot);
  let authorizeMutation;
  if (typeof config.workActionAuthorizationModule === 'string' && config.workActionAuthorizationModule) {
    const trusted = trustedModulePath(config.workActionAuthorizationModule, workspaceRoot);
    if (!trusted) throw new Error('workActionAuthorizationModule must be an owner-only regular file contained under workspaceRoot');
    const loaded = require(trusted);
    authorizeMutation = typeof loaded === 'function' ? loaded : loaded.authorizeMutation;
  }
  return {
    workspaceRoot,
    beadsWorkspace,
    approvedWorkspaceIds,
    operationStoreRoot,
    authorizeMutation,
  };
}

// Mirrors the containment gate in jarvos-mcp.js. The MCP server validates the path
// it was handed, but everything this file loads afterwards is invisible to that check:
// a hostile value in the config JSON or the environment would otherwise reach require()
// through a module the host has already trusted. Widening a trust boundary one hop past
// the gate is how gates stop meaning anything.
function trustedModulePath(candidate, workspaceRoot) {
  if (typeof candidate !== 'string' || !path.isAbsolute(candidate)) return null;
  try {
    if (fs.lstatSync(candidate).isSymbolicLink()) return null;
    const real = fs.realpathSync(candidate);
    const stat = fs.statSync(real);
    const uid = typeof process.getuid === 'function' ? process.getuid() : null;
    if (!stat.isFile() || (uid !== null && stat.uid !== uid) || (stat.mode & 0o077) !== 0) return null;
    const relative = path.relative(fs.realpathSync(workspaceRoot), real);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return null;
    return real;
  } catch {
    return null;
  }
}

function createHostWorkActionService() {
  const host = readHostOptions();
  const codingPath = trustedModulePath(resolveCodingModule(), host.workspaceRoot);
  if (!codingPath) throw new Error('jarvos-coding module must be an owner-only regular file contained under workspaceRoot');
  const coding = require(codingPath);
  const tracker = coding.createLiveBeadsTracker({
    workspaceRoot: host.beadsWorkspace,
    approvedRoots: [host.workspaceRoot, host.beadsWorkspace],
    operationStoreRoot: host.operationStoreRoot || undefined,
  });
  return coding.createBeadsWorkActionService({
    tracker,
    executionLinks: coding.createMemoryExecutionLinkStore(),
    approvedWorkspaceIds: host.approvedWorkspaceIds,
    authorizeMutation: host.authorizeMutation,
  });
}

module.exports = createHostWorkActionService;
