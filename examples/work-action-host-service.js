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

// Where the coding module came from decides how far it has to be vetted. A value
// read from the environment is caller input and gets the full containment check;
// a path derived from the MCP that loaded this file is part of the same install
// and is trusted by provenance instead. Checking both against workspaceRoot was
// wrong: the install tree is a different tree, and its files are mode 644 by
// design, so the documented setup could never bind.
function resolveCodingModule() {
  const explicit = process.env.JARVOS_CODING_MODULE;
  if (typeof explicit === 'string' && explicit.trim()) return { specifier: explicit.trim(), source: 'configured' };
  const parentFile = module.parent && module.parent.filename;
  if (typeof parentFile === 'string') {
    const fromMcp = [
      path.resolve(path.dirname(parentFile), '..', '..', 'jarvos-coding', 'src', 'index.js'),
      path.resolve(path.dirname(parentFile), '..', '..', 'coding', 'src', 'index.js'),
    ];
    for (const candidate of fromMcp) {
      try {
        if (fs.statSync(candidate).isFile()) return { specifier: candidate, source: 'install' };
      } catch {
        // Keep looking; the packaged name is a fallback.
      }
    }
  }
  return { specifier: '@jarvos/coding', source: 'package' };
}

// An install-relative module still may not be a symlink into somewhere else, but
// it is not required to sit under workspaceRoot or to be owner-only.
function installModulePath(candidate) {
  try {
    if (fs.lstatSync(candidate).isSymbolicLink()) return null;
    const real = fs.realpathSync(candidate);
    return fs.statSync(real).isFile() ? real : null;
  } catch {
    return null;
  }
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
  const resolved = resolveCodingModule();
  let codingRequest = resolved.specifier;
  if (resolved.source === 'configured') {
    codingRequest = trustedModulePath(resolved.specifier, host.workspaceRoot);
    if (!codingRequest) throw new Error('JARVOS_CODING_MODULE must be an owner-only regular file contained under workspaceRoot');
  } else if (resolved.source === 'install') {
    codingRequest = installModulePath(resolved.specifier);
    if (!codingRequest) throw new Error('the jarvOS coding module beside this MCP install is not a regular file');
  }
  const coding = require(codingRequest);
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
