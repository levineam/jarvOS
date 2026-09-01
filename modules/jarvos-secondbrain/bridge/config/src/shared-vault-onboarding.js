#!/usr/bin/env node
/**
 * Sync a new runtime with an existing jarvOS installation.
 *
 * A runtime such as Hermes should not need runtime-specific path instructions.
 * Point this helper at an existing vault once; it writes a portable
 * jarvos.config.json that the normal resolveConfig() pipeline can reuse.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  DEFAULT_TIMEZONE,
  DEFAULT_USER_NAME,
  assertNotStaleVaultPath,
  expandTilde,
  isUsablePath,
  isValidTimezone,
  resolveConfig,
} = require('./resolve-config');

const DEFAULT_VAULT_CANDIDATES = [
  path.join('~', 'Vaults', 'Vault v3'),
  path.join('~', 'Documents', 'Vault v3'),
];

function asAbsolutePath(value, home) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const expanded = expandTilde(value.trim(), home);
  return path.isAbsolute(expanded) ? expanded : path.resolve(expanded);
}

// The canonical vault tree locations the sync contract knows about and
// validates. These names are used only for vault-shape validation; ordinary
// config publication selects an outside-vault target and never enumerates the
// vault.
const SHARED_VAULT_SUBDIRECTORIES = ['Notes', 'Journal', 'Tags'];

function hasSharedVaultShape(vaultDir) {
  return Boolean(
    vaultDir
    && SHARED_VAULT_SUBDIRECTORIES.every((directory) => (
      fs.statSync(path.join(vaultDir, directory), { throwIfNoEntry: false })?.isDirectory()
    )),
  );
}

function missingSharedVaultDirectories(vaultDir) {
  return SHARED_VAULT_SUBDIRECTORIES.filter((directory) => (
    !fs.statSync(path.join(vaultDir, directory), { throwIfNoEntry: false })?.isDirectory()
  ));
}

function hasDoNotUseMarker(vaultDir) {
  return fs.existsSync(path.join(vaultDir, 'DO_NOT_USE.txt'));
}

function discoverExistingVault({ homeDir = os.homedir(), candidates = DEFAULT_VAULT_CANDIDATES } = {}) {
  const matches = candidates
    .map((candidate) => asAbsolutePath(candidate, homeDir))
    .filter(Boolean)
    .filter((candidate) => hasSharedVaultShape(candidate) && !hasDoNotUseMarker(candidate));

  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    throw new Error(`Multiple existing vaults found: ${matches.join(', ')}. Pass --vault explicitly.`);
  }
  return null;
}

function buildSharedVaultConfig({
  vaultDir,
  workspaceRoot,
  homeDir = os.homedir(),
  user = {},
} = {}) {
  const resolvedVault = asAbsolutePath(vaultDir, homeDir);
  if (!resolvedVault) {
    throw new Error('A shared vault path is required. Pass --vault or create ~/Vaults/Vault v3.');
  }
  if (!hasSharedVaultShape(resolvedVault)) {
    const missing = missingSharedVaultDirectories(resolvedVault);
    throw new Error(`Existing jarvOS vault is missing required directories (${missing.join(', ')}): ${resolvedVault}`);
  }
  assertNotStaleVaultPath(resolvedVault, { home: homeDir, source: 'config' });

  const resolvedWorkspace = asAbsolutePath(workspaceRoot || path.join(homeDir, 'clawd'), homeDir);
  const timezone = user.timezone || DEFAULT_TIMEZONE;
  if (!isValidTimezone(timezone)) {
    throw new Error('A valid IANA timezone is required (for example, America/New_York or UTC)');
  }
  // Whitespace is not a name.  Without this a `--name " "` sync would write an
  // identity that reads as blank everywhere it is rendered.
  const name = user.name === undefined || user.name === null ? DEFAULT_USER_NAME : user.name;
  if (typeof name !== 'string' || !name.trim()) {
    throw new Error('A non-empty user name is required');
  }

  return {
    $schema: 'https://raw.githubusercontent.com/levineam/jarvOS/main/jarvos.config.schema.json',
    paths: {
      workspace: resolvedWorkspace,
      vault: resolvedVault,
      notes: path.join(resolvedVault, 'Notes'),
      journal: path.join(resolvedVault, 'Journal'),
      tags: path.join(resolvedVault, 'Tags'),
      memory: path.join(resolvedWorkspace, 'memory'),
      scripts: path.join(resolvedWorkspace, 'scripts'),
      workflows: path.join(resolvedWorkspace, 'workflows'),
      customers: path.join(resolvedWorkspace, 'customers'),
    },
    user: {
      name,
      timezone,
    },
  };
}

function resolvedConfigPaths(config, homeDir) {
  const configured = config?.paths && typeof config.paths === 'object' ? config.paths : {};
  const workspace = asAbsolutePath(configured.workspace || config?.workspacePath, homeDir);
  const vault = asAbsolutePath(configured.vault || config?.vaultPath, homeDir);
  return {
    workspace,
    vault,
    notes: asAbsolutePath(configured.notes, homeDir) || (vault && path.join(vault, 'Notes')),
    journal: asAbsolutePath(configured.journal, homeDir) || (vault && path.join(vault, 'Journal')),
    tags: asAbsolutePath(configured.tags, homeDir) || (vault && path.join(vault, 'Tags')),
    memory: asAbsolutePath(configured.memory, homeDir) || (workspace && path.join(workspace, 'memory')),
    scripts: asAbsolutePath(configured.scripts, homeDir) || (workspace && path.join(workspace, 'scripts')),
    workflows: asAbsolutePath(configured.workflows, homeDir) || (workspace && path.join(workspace, 'workflows')),
    customers: asAbsolutePath(configured.customers, homeDir) || (workspace && path.join(workspace, 'customers')),
  };
}

function isCompatibleSharedVaultConfig(existing, expected, homeDir = os.homedir()) {
  if (!existing || typeof existing !== 'object' || Array.isArray(existing)) return false;
  const existingPaths = resolvedConfigPaths(existing, homeDir);
  const expectedPaths = resolvedConfigPaths(expected, homeDir);
  const pathsMatch = Object.keys(expectedPaths).every((key) => existingPaths[key] === expectedPaths[key]);
  const existingName = existing.user?.name || existing.userName;
  const existingTimezone = existing.user?.timezone
    || existing.user?.timeZone
    || existing.timezone
    || existing.timeZone;
  // Old bootstrap configs did not record identity metadata.  Their paths are
  // still authoritative; a supplied sync identity is an additive onboarding
  // comparison, not a conflicting target.
  const nameCompatible = !existingName || existingName === expected.user.name;
  const timezoneCompatible = !existingTimezone || existingTimezone === expected.user.timezone;
  return pathsMatch && nameCompatible && timezoneCompatible;
}

// Retain the pure merge helper for callers that want to prepare a manual
// reconciliation. The sync writer never invokes it and never rewrites an
// existing target in place.
function migratedSharedVaultConfig(existing, expected) {
  return {
    ...existing,
    ...expected,
    paths: { ...(existing.paths || {}), ...expected.paths },
    user: { ...(existing.user || {}), ...expected.user },
  };
}

function hasPortableRuntimeConfig(existing, expected, homeDir = os.homedir(), runtimePaths = null) {
  if (!existing?.paths || typeof existing.paths !== 'object' || !existing?.user || typeof existing.user !== 'object') return false;
  const existingPaths = resolvedConfigPaths(existing, homeDir);
  const expectedPaths = resolvedConfigPaths(expected, homeDir);
  const derivedPathKeys = new Set([
    'notes', 'journal', 'tags', 'memory', 'scripts', 'workflows', 'customers',
  ]);
  // Every raw value must be one the runtime would actually use.  A relative
  // paths.* entry is dropped by normalizePathMap() in favour of the
  // home-directory default, so a supplied relative config is never
  // already-synced however its cwd-anchored comparison happens to land. The
  // resolver intentionally derives omitted child paths from a configured
  // workspace or vault, so those optional omissions are portable when their
  // resolved value still matches the expected installation.
  return Object.keys(expectedPaths).every((key) => existingPaths[key] === expectedPaths[key]
    && (!runtimePaths || runtimePaths[key] === expectedPaths[key])
    && (Object.hasOwn(existing.paths, key)
      ? isUsablePath(existing.paths[key], homeDir)
      : derivedPathKeys.has(key)))
    && existing.user.name === expected.user.name
    && existing.user.timezone === expected.user.timezone;
}

function isSameOrDescendant(parentPath, candidatePath) {
  const parent = path.resolve(parentPath);
  const candidate = path.resolve(candidatePath);
  return candidate === parent || candidate.startsWith(`${parent}${path.sep}`);
}

const MACOS_SYSTEM_PARENT_ALIASES = new Map([
  ['/tmp', '/private/tmp'],
  ['/var', '/private/var'],
]);

// macOS exposes /tmp and /var as stable system-parent aliases. They are the
// only symlinked path components this publication path may traverse. The
// final config target is never an alias: passing a null target is reserved for
// the directory-creation check, where the directory itself may be /tmp or
// /var. The realpath check keeps this exception narrow if a host changes one
// of those system entries.
function isAllowedMacOSSystemParentAlias(component, target, platform = process.platform, realpathSync = fs.realpathSync) {
  if (platform !== 'darwin' || (target && component === target)) return false;
  const expectedRealPath = MACOS_SYSTEM_PARENT_ALIASES.get(component);
  if (!expectedRealPath) return false;
  try {
    return realpathSync(component) === expectedRealPath;
  } catch {
    return false;
  }
}

function assertNoSymlinkedConfigPathComponents(
  target,
  platform = process.platform,
  allowFinalMacOSSystemParentAlias = false,
) {
  const absolute = path.resolve(target);
  const parsed = path.parse(absolute);
  const components = absolute.slice(parsed.root.length).split(path.sep).filter(Boolean);
  let current = parsed.root;
  let missingAncestor = false;
  // A config target must not itself be a symlink. Directory publication may
  // legitimately use /tmp or /var as its final parent spelling, however.
  const aliasTarget = allowFinalMacOSSystemParentAlias ? null : absolute;

  for (const component of components) {
    current = path.join(current, component);
    if (missingAncestor) continue;
    try {
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink() && !isAllowedMacOSSystemParentAlias(current, aliasTarget, platform)) {
        throw new Error(`Refusing to write through a symlinked config path: ${current}`);
      }
    } catch (error) {
      if (error.code === 'ENOENT') {
        missingAncestor = true;
        continue;
      }
      throw error;
    }
  }
}

function ensureDirectoryPathWithoutSymlinks(directory, platform = process.platform) {
  const absolute = path.resolve(directory);
  const parsed = path.parse(absolute);
  const components = absolute.slice(parsed.root.length).split(path.sep).filter(Boolean);
  let current = parsed.root;
  for (const component of components) {
    current = path.join(current, component);
    let stat;
    try {
      stat = fs.lstatSync(current);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      try {
        fs.mkdirSync(current, { mode: 0o700 });
      } catch (mkdirError) {
        if (mkdirError.code !== 'EEXIST') throw mkdirError;
      }
      stat = fs.lstatSync(current);
    }
    if (stat.isSymbolicLink()) {
      if (!isAllowedMacOSSystemParentAlias(current, null, platform)) {
        throw new Error(`Refusing to write through a symlinked config path: ${current}`);
      }
      stat = fs.statSync(current);
    }
    if (!stat.isDirectory()) throw new Error(`Refusing to use a non-directory config path component: ${current}`);
    assertNoSymlinkedConfigPathComponents(absolute, platform, true);
  }
}

function canonicalizePathWithMissingTail(target) {
  let existing = target;
  const missingTail = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync(existing), ...missingTail);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const parent = path.dirname(existing);
      if (parent === existing) throw error;
      missingTail.unshift(path.basename(existing));
      existing = parent;
    }
  }
}

function assertConfigTargetOutsideVault(target, vaultDir, homeDir) {
  const vault = asAbsolutePath(vaultDir, homeDir);
  if (!vault) return;

  let canonicalVault;
  try {
    canonicalVault = fs.realpathSync(vault);
  } catch (error) {
    throw new Error(`Refusing to use an unreadable existing vault: ${vault} (${error.message})`);
  }
  let canonicalTarget;
  try {
    canonicalTarget = canonicalizePathWithMissingTail(target);
  } catch (error) {
    throw new Error(`Refusing to inspect an unreadable config path: ${target} (${error.message})`);
  }
  if (isSameOrDescendant(canonicalVault, canonicalTarget)) {
    throw new Error(`Refusing to place jarvos.config.json inside the shared vault: ${target}`);
  }
}

// Publication is only safe when the caller supplies the vault selected for
// this runtime. The lower-level create helper is exported, so it cannot rely
// on buildSharedVaultConfig() having validated that context first.
function normalizeSelectedVaultDir(vaultDir, homeDir = os.homedir()) {
  const selected = asAbsolutePath(vaultDir, homeDir);
  if (!selected) {
    throw new Error('Config publication requires an explicit selected vaultDir');
  }
  const normalized = path.resolve(selected);
  let stat;
  try {
    stat = fs.statSync(normalized);
  } catch (error) {
    throw new Error(`Refusing to use an unreadable selected vault: ${normalized} (${error.message})`);
  }
  if (!stat.isDirectory()) {
    throw new Error(`Refusing to use a selected vault that is not a directory: ${normalized}`);
  }
  assertNotStaleVaultPath(normalized, { home: homeDir, source: 'config' });
  return normalized;
}

function readSharedVaultConfigTarget({ configPath, homeDir = os.homedir(), platform = process.platform } = {}) {
  const target = asAbsolutePath(configPath || path.join(process.cwd(), 'jarvos.config.json'), homeDir);
  assertNoSymlinkedConfigPathComponents(target, platform);

  let targetStat;
  try {
    targetStat = fs.lstatSync(target);
  } catch (error) {
    if (error.code === 'ENOENT') return { configPath: target, config: null, exists: false };
    throw new Error(`Refusing to inspect an unreadable config path: ${target} (${error.message})`);
  }
  let existing;
  try {
    existing = JSON.parse(fs.readFileSync(target, 'utf8'));
  } catch (error) {
    throw new Error(`Refusing to overwrite an unreadable existing config: ${target} (${error.message})`);
  }
  // A file holding valid JSON `null` (or any non-object) parses without error
  // but cannot be compared or merged.  Refusing here keeps dry-run and apply
  // consistent: without it the dry run would plan a `create` that the exclusive
  // apply write then fails with EEXIST.
  if (existing === null || typeof existing !== 'object' || Array.isArray(existing)) {
    throw new Error(`Refusing to overwrite an existing config that is not a JSON object: ${target}`);
  }
  return { configPath: target, config: existing, exists: true, targetStat };
}

function assessSharedVaultConfigTarget({
  configPath,
  config,
  vaultDir,
  homeDir = os.homedir(),
  platform = process.platform,
  env = process.env,
} = {}) {
  const targetState = readSharedVaultConfigTarget({ configPath, homeDir, platform });
  const target = targetState.configPath;
  const configuredVault = vaultDir || config?.paths?.vault || config?.vaultPath;
  assertConfigTargetOutsideVault(target, configuredVault, homeDir);
  if (!targetState.exists) return { action: 'create', configPath: target };

  const compatible = isCompatibleSharedVaultConfig(targetState.config, config, homeDir);
  let runtimePaths = false;
  try {
    runtimePaths = resolveConfig({ configPath: target, homeDir, env }).paths;
  } catch {
    // A legacy file that the runtime cannot resolve is not portable enough to
    // call already-synced. Keep it in the existing manual-reconciliation path.
  }
  return {
    action: compatible
      ? (runtimePaths && hasPortableRuntimeConfig(targetState.config, config, homeDir, runtimePaths)
        ? 'already-synced'
        : 'migrate')
      : 'conflict',
    configPath: target,
  };
}

// Assessment outcomes that can be carried out by this module. Legacy configs
// are deliberately reported as `migrate` by the compatibility assessment, but
// writeSharedVaultConfig() turns that outcome into a manual-reconciliation
// diagnostic instead of attempting an in-place rewrite.
const CONFIG_PUBLICATION_ACTIONS = new Set(['create']);
const MANUAL_RECONCILIATION_ACTION = 'manual-reconcile';

function requiresConfigPublication(action) {
  return CONFIG_PUBLICATION_ACTIONS.has(action);
}

function manualReconciliationError(target) {
  return new Error(
    `Cannot automatically migrate the existing config at ${target}. `
    + 'jarvos sync never rewrites an existing legacy config in place. '
    + 'Reconcile it manually, or pass --config to a new path and sync there.',
  );
}

/**
 * Whether this runtime can actually pin a directory by descriptor.
 *
 * withPinnedDirectory() OR's O_RDONLY with O_DIRECTORY and O_NOFOLLOW; if
 * either flag is missing, Node substitutes `undefined`, and the bitwise OR
 * silently degrades to whatever the remaining flags happen to mean — an
 * unverified open mode, not a verified directory-only, non-symlink pin.  This
 * is a small pure predicate (constants injectable) rather than a check that
 * mutates the real fs.constants: each of its properties is defined
 * non-writable and non-configurable, so an in-place override throws in strict
 * mode instead of taking effect, and a test must not depend on working around
 * that.
 */
function hasPosixDirectoryPinCapability(constants = fs.constants) {
  return Number.isInteger(constants?.O_DIRECTORY)
    && constants.O_DIRECTORY > 0
    && Number.isInteger(constants?.O_NOFOLLOW)
    && constants.O_NOFOLLOW > 0;
}

/**
 * Publication needs O_DIRECTORY/O_NOFOLLOW to pin the config directory by
 * descriptor.  Windows has neither, and this repository has no Windows CI to
 * establish that Node's dev/ino are stable enough there to substitute a
 * stat-based identity check, so publication fails closed rather than shipping
 * an unverified guarantee or a predictable-target write.  The same failure
 * applies to any other platform/runtime whose fs.constants does not define
 * both flags as usable integers: an unrecognized platform is exactly as
 * unverified as a known-unsupported one, so it gets the same closed door
 * rather than a silent, unverified open() mode.
 *
 * Pure and platform-parameterized (and constants-parameterized, for tests
 * that cannot and should not mutate the real, non-writable fs.constants) so
 * planning and applying can share one verdict and one message: a dry run must
 * not report a plannable write that apply is guaranteed to refuse.
 */
function assertConfigPublicationSupported(platform = process.platform, constants = fs.constants) {
  if (platform !== 'win32' && hasPosixDirectoryPinCapability(constants)) return;
  throw new Error(
    `jarvos sync cannot publish a config on ${platform}: it pins the config directory with a `
    + 'POSIX directory descriptor (O_DIRECTORY/O_NOFOLLOW) to prove the directory cannot be '
    + 'swapped mid-write, and this platform provides no verified equivalent. '
    + 'Run jarvos sync on macOS or Linux with the standard Node fs.constants, which define both.',
  );
}

/**
 * Hold an open descriptor on the directory that publishes the config and give
 * the caller a recheck to run around each mutating syscall.
 *
 * Node exposes no openat(), so the parent cannot be addressed purely by
 * descriptor. Holding it still pins the identity that was validated: if a
 * a simultaneous edit replaces the directory entry with a symlink, lstat() then reports the
 * symlink's own inode and the recheck fails closed. Publication uses an
 * exclusive final target and rechecks its inode, so a substituted pathname
 * cannot overwrite an existing target.
 */
function withPinnedDirectory(directory, publish, constants = fs.constants) {
  const fd = fs.openSync(directory, fs.constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const pinned = fs.fstatSync(fd);
    const changed = () => new Error(`Refusing to write through a config directory that changed during sync: ${directory}`);
    const assertUnchanged = () => {
      let current;
      try {
        current = fs.lstatSync(directory);
      } catch (error) {
        // A directory renamed away with nothing put back in its place is the
        // same failure as a simultaneous symlink replacement; report it the same way
        // rather than leaking a raw ENOENT.
        if (error.code === 'ENOENT') throw changed();
        throw error;
      }
      if (current.isSymbolicLink() || current.dev !== pinned.dev || current.ino !== pinned.ino) {
        throw changed();
      }
    };
    assertUnchanged();
    return publish(assertUnchanged, fd);
  } finally {
    // A throw from closeSync here — an already-broken descriptor, most
    // plausibly — would replace whatever error `publish` above is
    // propagating, since a `finally` block's own throw wins over an
    // in-flight one.  That would surface a confusing close-time errno in
    // place of the actual diagnostic (a changed directory, an additional name,
    // an unsupported filesystem). Best effort only: the fd is being
    // discarded either way.
    try {
      fs.closeSync(fd);
    } catch {
      // ignored: never mask the primary diagnostic from the try block above
    }
  }
}

/**
 * Re-establish *where* the pinned directory is, not merely that it is unchanged.
 *
 * Every other check here is self-referential: it proves the directory has not
 * changed since it was pinned.  An ancestor redirected before the pin defeats
 * all of them, because the descriptor and the lstat then agree perfectly on a
 * directory that may sit inside the vault.  Canonicalizing the pinned directory
 * and proving the canonical path names the same inode as the descriptor makes
 * that canonical path trustworthy, so vault containment can be re-decided
 * against where the write will actually land.
 */
function assertPinnedDirectoryOutsideVault(directory, fd, target, { vaultDir, homeDir } = {}) {
  if (!vaultDir) {
    throw new Error('Config publication requires an explicit selected vaultDir');
  }
  let canonical;
  try {
    canonical = fs.realpathSync(directory);
  } catch (error) {
    throw new Error(`Refusing to inspect an unreadable config directory: ${directory} (${error.message})`);
  }
  // realpathSync succeeding does not guarantee the resolved path is still
  // there an instant later; attribute a failure here the same way as the
  // realpathSync above rather than letting a raw, unwrapped ENOENT escape.
  let canonicalStat;
  try {
    canonicalStat = fs.lstatSync(canonical);
  } catch (error) {
    throw new Error(`Refusing to inspect an unreadable config directory: ${directory} (${error.message})`);
  }
  const pinned = fs.fstatSync(fd);
  if (canonicalStat.dev !== pinned.dev || canonicalStat.ino !== pinned.ino) {
    throw new Error(`Refusing to publish through a config directory whose canonical path is not the pinned directory: ${directory}`);
  }
  assertConfigTargetOutsideVault(path.join(canonical, path.basename(target)), vaultDir, homeDir);
}

/**
 * Prove that a pathname still names the exact inode behind our retained fd.
 * This is used immediately after the exclusive target open and again after
 * writing. A mismatch is a failure, never a reason to remove or replace a
 * pathname: the target may now have been changed by a simultaneous edit.
 */
function targetEntryMatchesDescriptor(target, fd) {
  try {
    const entry = fs.lstatSync(target);
    const held = fs.fstatSync(fd);
    return !entry.isSymbolicLink() && entry.dev === held.dev && entry.ino === held.ino;
  } catch {
    return false;
  }
}

function assertTargetEntryUnchanged(target, fd) {
  if (!targetEntryMatchesDescriptor(target, fd)) {
    throw new Error(`Refusing to write through a config target that changed during sync: ${target}`);
  }
}

function assertDescriptorHasSingleName(fd, target) {
  const held = fs.fstatSync(fd);
  if (held.nlink !== 1) {
    throw new Error(`Refusing to write through a config target with additional names: ${target}`);
  }
}

function assertDescriptorContents(fd, expected, target) {
  const before = fs.fstatSync(fd);
  if (before.size !== expected.length) {
    throw new Error(`Refusing to report config creation as successful: ${target} changed during sync`);
  }

  const actual = Buffer.alloc(expected.length);
  let offset = 0;
  while (offset < expected.length) {
    const bytesRead = fs.readSync(fd, actual, offset, expected.length - offset, offset);
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  const after = fs.fstatSync(fd);
  if (offset !== expected.length || after.size !== expected.length || !actual.equals(expected)) {
    throw new Error(`Refusing to report config creation as successful: ${target} changed during sync`);
  }
}

/**
 * Create the final config directly through an exclusive retained descriptor.
 *
 * There is intentionally no temporary pathname and no link/rename/unlink
 * cleanup. O_EXCL makes an existing target fail closed; the parent directory
 * descriptor and target dev/ino checks ensure a changed pathname is never
 * treated as our target before bytes are written. If anything fails after
 * creation, truncate only the fd we opened and leave its pathname in place —
 * Node has no fd-relative unlink primitive, and a failed-create residue may
 * require manual removal.
 */
function createConfigExclusively(target, contents, {
  vaultDir,
  homeDir = os.homedir(),
  platform = process.platform,
  constants,
} = {}) {
  const selectedVault = normalizeSelectedVaultDir(vaultDir, homeDir);
  assertConfigPublicationSupported(platform, constants);
  const directory = path.dirname(target);
  const expected = Buffer.from(contents, 'utf8');
  // Validate the requested target before pinning and repeat the containment
  // decision against the canonical pinned directory below.
  assertNoSymlinkedConfigPathComponents(target, platform);
  assertConfigTargetOutsideVault(target, selectedVault, homeDir);
  return withPinnedDirectory(directory, (assertUnchanged, directoryFd) => {
    // Decide containment against the directory actually pinned before the
    // exclusive target open; an ancestor redirected before the pin cannot make
    // a vault path look like an ordinary workspace path.
    assertPinnedDirectoryOutsideVault(directory, directoryFd, target, { vaultDir: selectedVault, homeDir });

    let fd;
    let complete = false;
    try {
      // O_EXCL|O_CREAT is the only pathname operation in publication. It can
      // create an empty residue if the parent changes in the narrow syscall
      // window, but it can never open or overwrite an existing target.
      // `+` keeps the retained descriptor readable for the final exact-byte
      // proof while preserving O_EXCL|O_CREAT semantics.
      fd = fs.openSync(target, 'wx+', 0o600);
      // Immediately after creation, prove both the parent and the target are
      // still the objects we validated before opening them.
      assertUnchanged();
      assertTargetEntryUnchanged(target, fd);
      assertDescriptorHasSingleName(fd, target);

      fs.writeFileSync(fd, expected);
      if (typeof fs.fsyncSync === 'function') fs.fsyncSync(fd);

      // Verify the parent and target again after the write, then read the exact
      // bytes back through the retained descriptor. No path-based read is
      // needed, so a substituted target pathname cannot supply the success
      // evidence.
      assertUnchanged();
      assertTargetEntryUnchanged(target, fd);
      assertDescriptorHasSingleName(fd, target);
      assertDescriptorContents(fd, expected, target);
      assertDescriptorHasSingleName(fd, target);
      complete = true;
    } finally {
      if (fd !== undefined) {
        if (!complete) {
          // The descriptor belongs only to the file created by this attempt.
          // Never unlink its pathname: a simultaneous edit may have moved or
          // replaced it.
          try { fs.ftruncateSync(fd, 0); } catch { /* best effort */ }
        }
        try { fs.closeSync(fd); } catch { /* do not mask the primary error */ }
      }
    }
  }, constants);
}

// Kept as a narrow compatibility surface for direct callers. In-place
// replacement is no longer a supported operation; throwing here guarantees a
// caller cannot accidentally reintroduce pathname rename publication.
function atomicReplaceConfig(target) {
  throw manualReconciliationError(target);
}

function writeSharedVaultConfig({
  configPath,
  vaultDir,
  workspaceRoot,
  homeDir = os.homedir(),
  platform = process.platform,
  constants = fs.constants,
  user,
  env = process.env,
} = {}) {
  const target = asAbsolutePath(configPath || path.join(process.cwd(), 'jarvos.config.json'), homeDir);
  const config = buildSharedVaultConfig({ vaultDir, workspaceRoot, homeDir, user });
  const assessment = assessSharedVaultConfigTarget({ configPath: target, config, vaultDir, homeDir, platform, env });
  if (assessment.action === 'already-synced') {
    return { configPath: target, config, changed: false };
  }
  if (assessment.action === 'conflict') {
    throw new Error(
      `Refusing to overwrite an existing jarvos.config.json: ${target}. `
      + 'Choose a new --config path or reconcile the existing config manually.',
    );
  }

  if (assessment.action === 'migrate') {
    // The assessment already read the target once.  Stop here without a
    // reread, merge, rename, or other mutation: even if a simultaneous edit changes
    // the legacy file immediately after assessment, sync cannot overwrite it.
    throw manualReconciliationError(target);
  }

  // Fail before any create-parent provisioning. A dry-run, CLI apply, and
  // direct module entry point must share the same capability verdict, while
  // already-synced/conflict/manual-reconcile paths remain read-only.
  if (requiresConfigPublication(assessment.action)) {
    assertConfigPublicationSupported(platform, constants);
  }

  ensureDirectoryPathWithoutSymlinks(path.dirname(target), platform);
  const finalState = readSharedVaultConfigTarget({ configPath: target, homeDir, platform });
  if (finalState.exists) throw new Error(`Refusing to write a config target that changed during sync: ${target}`);
  createConfigExclusively(target, `${JSON.stringify(config, null, 2)}\n`, {
    vaultDir,
    homeDir,
    platform,
    constants,
  });
  return { configPath: target, config, changed: true };
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === '--vault') {
      options.vaultDir = next;
      index += 1;
    } else if (arg === '--workspace') {
      options.workspaceRoot = next;
      index += 1;
    } else if (arg === '--config') {
      options.configPath = next;
      index += 1;
    } else if (arg === '--name') {
      options.user = { ...(options.user || {}), name: next };
      index += 1;
    } else if (arg === '--timezone') {
      options.user = { ...(options.user || {}), timezone: next };
      index += 1;
    } else if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

function usage() {
  return [
    'Usage: node bridge/config/src/shared-vault-onboarding.js [--vault PATH] [--workspace PATH] [--config PATH] [--dry-run]',
    '',
    'Sync with an existing jarvOS installation by pointing this runtime at its shared vault.',
    'If --vault is omitted, the helper uses ~/Vaults/Vault v3 when it contains Notes/, Journal/, and Tags/.',
    'In ordinary, uncontended use the helper selects an outside-vault target and refuses to replace a different existing config.',
  ].join('\n');
}

function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log(usage());
    return { ok: true, help: true };
  }

  const homeDir = os.homedir();
  const platform = process.platform;
  const constants = fs.constants;
  const vaultDir = options.vaultDir || discoverExistingVault({ homeDir });
  if (options.dryRun) {
    const config = buildSharedVaultConfig({ ...options, vaultDir, homeDir });
    const assessment = assessSharedVaultConfigTarget({
      configPath: options.configPath,
      config,
      vaultDir,
      homeDir,
      platform,
    });
    if (assessment.action === 'migrate') {
      console.log(JSON.stringify({
        ok: true,
        action: MANUAL_RECONCILIATION_ACTION,
        targetAction: MANUAL_RECONCILIATION_ACTION,
        manualReconciliation: true,
        paths: config.paths,
        message: manualReconciliationError(assessment.configPath).message,
      }, null, 2));
      return { ok: true, config, manualReconciliation: true };
    }
    // A plan that apply is guaranteed to refuse is not a plan.
    if (requiresConfigPublication(assessment.action)) assertConfigPublicationSupported(platform, constants);
    console.log(JSON.stringify({ ok: true, action: 'dry-run', targetAction: assessment.action, paths: config.paths }, null, 2));
    return { ok: true, config };
  }

  const result = writeSharedVaultConfig({ ...options, vaultDir, homeDir, platform, constants });
  console.log(JSON.stringify({
    ok: true,
    configPath: result.configPath,
    vault: result.config.paths.vault,
    notes: result.config.paths.notes,
    journal: result.config.paths.journal,
  }, null, 2));
  return { ok: true, ...result };
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    console.error(usage());
    process.exitCode = 1;
  }
}

module.exports = {
  DEFAULT_VAULT_CANDIDATES,
  assertConfigPublicationSupported,
  atomicReplaceConfig,
  assessSharedVaultConfigTarget,
  buildSharedVaultConfig,
  createConfigExclusively,
  discoverExistingVault,
  hasPosixDirectoryPinCapability,
  hasSharedVaultShape,
  isAllowedMacOSSystemParentAlias,
  isCompatibleSharedVaultConfig,
  MANUAL_RECONCILIATION_ACTION,
  manualReconciliationError,
  migratedSharedVaultConfig,
  readSharedVaultConfigTarget,
  requiresConfigPublication,
  writeSharedVaultConfig,
};
