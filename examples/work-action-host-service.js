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
  const workspaceRoot = protectedDirectory(config.workspaceRoot, 'Projects context workspaceRoot');
  const beadsWorkspace = config.beadsWorkspace
    ? protectedDirectory(config.beadsWorkspace, 'Projects context beadsWorkspace')
    : workspaceRoot;
  const workspaceId = opaqueWorkspaceId(config.beadsWorkspaceId);
  const approvedWorkspaceIds = Array.isArray(config.approvedWorkspaceIds) && config.approvedWorkspaceIds.length > 0
    ? config.approvedWorkspaceIds
    : [workspaceId];
  const trackerOperationStoreRoot = protectedRoot(config.trackerOperationStoreRoot, 'trackerOperationStoreRoot');
  const operationStoreRoot = protectedRoot(config.workActionOperationStoreRoot, 'workActionOperationStoreRoot');
  const executionLinkStoreRoot = protectedRoot(config.executionLinkStoreRoot, 'executionLinkStoreRoot');
  if (rootsOverlap([trackerOperationStoreRoot, operationStoreRoot, executionLinkStoreRoot])) {
    throw new Error('live work-action store roots must be distinct and non-overlapping');
  }
  const authorizationModule = trustedModulePath(config.workActionAuthorizationModule, workspaceRoot);
  if (!authorizationModule) throw new Error('workActionAuthorizationModule must be an owner-only regular file contained under workspaceRoot');
  const authorization = require(authorizationModule);
  const authorizeMutation = typeof authorization === 'function' ? authorization : authorization.authorizeMutation;
  if (typeof authorizeMutation !== 'function') throw new Error('workActionAuthorizationModule must export authorizeMutation');
  const completionModule = trustedModulePath(config.workActionCompletionModule, workspaceRoot);
  if (!completionModule) throw new Error('workActionCompletionModule must be an owner-only regular file contained under workspaceRoot');
  const completion = require(completionModule);
  const resolveCompletionReceipt = typeof completion === 'function' ? completion : completion.resolveCompletionReceipt;
  if (typeof resolveCompletionReceipt !== 'function') throw new Error('workActionCompletionModule must export resolveCompletionReceipt');
  const registeredEvidenceProducers = Array.isArray(config.registeredCompletionProducers)
    ? config.registeredCompletionProducers.filter((value) => typeof value === 'string' && value.trim())
    : [];
  if (!registeredEvidenceProducers.length) throw new Error('registeredCompletionProducers is required');
  return {
    workspaceRoot,
    beadsWorkspace,
    workspaceId,
    approvedWorkspaceIds,
    trackerOperationStoreRoot,
    operationStoreRoot,
    executionLinkStoreRoot,
    authorizeMutation,
    resolveCompletionReceipt,
    registeredEvidenceProducers,
  };
}

function opaqueWorkspaceId(value) {
  if (typeof value !== 'string' || !value.trim() || /[\\/\0]/.test(value)) {
    throw new Error('beadsWorkspaceId must be a pinned opaque workspace identity');
  }
  return value.trim();
}

function protectedDirectory(value, field) {
  const candidate = absolutePath(value);
  if (!candidate) throw new Error(`${field} must be an absolute path`);
  try {
    const resolved = fs.realpathSync(candidate);
    if (!fs.statSync(resolved).isDirectory()) throw new Error('not a directory');
    return resolved;
  } catch {
    throw new Error(`${field} must be an absolute path`);
  }
}

// Loading a service is not authorization to create or chmod state. Provisioning
// is an explicit host setup action; ordinary reads only validate existing roots.
function protectedRoot(value, field) {
  const candidate = absolutePath(value);
  if (!candidate) throw new Error(`${field} must be an absolute owner-only root`);
  try {
    if (fs.lstatSync(candidate).isSymbolicLink()) throw new Error('symbolic link');
    const root = fs.realpathSync(candidate);
    const stat = fs.statSync(root);
    const uid = typeof process.getuid === 'function' ? process.getuid() : null;
    if (root === path.parse(root).root || !stat.isDirectory() || (uid !== null && stat.uid !== uid)) throw new Error('untrusted root');
    if ((stat.mode & 0o077) !== 0) throw new Error('root is not owner-only');
    assertProtectedAncestry(path.dirname(root));
    return root;
  } catch {
    throw new Error(`${field} must be an absolute owner-only root`);
  }
}

function assertProtectedAncestry(start) {
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  let current = start;
  while (true) {
    const stat = fs.statSync(current);
    const writable = (stat.mode & 0o022) !== 0;
    const sticky = (stat.mode & 0o1000) !== 0;
    const trustedOwner = uid === null || stat.uid === uid || stat.uid === 0;
    if (!stat.isDirectory() || (writable && !sticky) || !trustedOwner) throw new Error('unsafe root ancestry');
    const parent = path.dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

function rootsOverlap(roots) {
  return roots.some((left, index) => roots.slice(index + 1).some((right) => {
    const relative = path.relative(left, right);
    const reverse = path.relative(right, left);
    return relative === ''
      || (relative && !relative.startsWith('..') && !path.isAbsolute(relative))
      || (reverse && !reverse.startsWith('..') && !path.isAbsolute(reverse));
  }));
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
    assertProtectedAncestry(path.dirname(real));
    return real;
  } catch {
    return null;
  }
}

function resolveExecutionLinkModule(codingRequest, source, workspaceRoot) {
  let codingFile;
  try {
    codingFile = require.resolve(codingRequest);
  } catch {
    throw new Error('the selected jarvOS coding module cannot be resolved');
  }
  const candidate = path.resolve(
    path.dirname(codingFile),
    '..',
    '..',
    'jarvos-secondbrain',
    'packages',
    'jarvos-secondbrain-projects',
    'src',
    'execution-link-store.js',
  );
  const selected = source === 'configured'
    ? trustedModulePath(candidate, workspaceRoot)
    : installModulePath(candidate);
  if (!selected) throw new Error('the Projects execution-link module beside jarvOS coding is unavailable');
  return selected;
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
  const projects = require(resolveExecutionLinkModule(codingRequest, resolved.source, host.workspaceRoot));
  if (typeof projects.createFileExecutionLinkStore !== 'function') {
    throw new Error('the Projects execution-link module is invalid');
  }
  const tracker = coding.createLiveBeadsTracker({
    workspaceRoot: host.beadsWorkspace,
    approvedRoots: [host.workspaceRoot, host.beadsWorkspace],
    operationStoreRoot: host.trackerOperationStoreRoot,
    mode: 'live',
  });
  return coding.createBeadsWorkActionService({
    tracker,
    mode: 'live',
    operationStore: coding.createFileOperationStore({ root: host.operationStoreRoot }),
    executionLinks: projects.createFileExecutionLinkStore({ root: host.executionLinkStoreRoot }),
    workspaceId: host.workspaceId,
    approvedWorkspaceIds: host.approvedWorkspaceIds,
    authorizeMutation: host.authorizeMutation,
    resolveCompletionReceipt: host.resolveCompletionReceipt,
    registeredEvidenceProducers: host.registeredEvidenceProducers,
  });
}

module.exports = createHostWorkActionService;
