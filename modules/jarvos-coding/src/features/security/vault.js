'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { durableSecurityWrite, syncDirectory } = require('./filesystem');
const {
  ACTIVATION_AUDIENCE,
  ACTIVATION_PURPOSE,
  ACTIVATION_TYPE,
  APPROVAL_STAMP_SCHEMA,
  approvalStampVerifierId,
} = require('./managed-software-activation');
const {
  PROJECTS_ISSUER_SCHEMA,
  PROJECT_CONTEXT_AUDIENCE,
  PROJECT_CONTEXT_PURPOSE,
  PROJECT_CONTEXT_TYPE,
  projectsVerifierId,
} = require('./projects-capability');

const VAULT_SCHEMA = 'jarvos.security-vault/v1';
const PURPOSES = Object.freeze(['activation', 'projects']);
const INCOMPLETE_LOCK_GRACE_MS = 5 * 60 * 1000;

function defaultRoot() {
  return process.env.JARVOS_SECURITY_ROOT || path.join(os.homedir(), '.jarvos', 'security');
}

function cleanRoot(value = defaultRoot()) {
  const resolved = path.resolve(value);
  if (!path.isAbsolute(resolved) || resolved === path.parse(resolved).root) {
    throw new Error('jarvOS security root must be a specific absolute path');
  }
  return resolved;
}

function vaultPaths(root = defaultRoot()) {
  const base = cleanRoot(root);
  return Object.freeze({
    root: base,
    setupLock: path.join(base, '.setup.lock'),
    manifest: path.join(base, 'vault.json'),
    secureEnclaveIdentity: path.join(base, 'touch-id-identity.txt'),
    recoveryIdentity: path.join(base, 'recovery-identity.age'),
    activationSigner: path.join(base, 'activation-private.pem.age'),
    activationDescriptor: path.join(base, 'activation-verifier.json'),
    projectsSigner: path.join(base, 'projects-capability-private.pem.age'),
    projectsDescriptor: path.join(base, 'projects-capability-verifier.json'),
  });
}

function defaultExecute(command, args, options = {}) {
  let stdio = ['pipe', 'pipe', 'pipe'];
  if (options.interactive === true && options.captureStdout === true) stdio = ['inherit', 'pipe', 'inherit'];
  else if (options.interactive === true && options.input !== undefined) stdio = ['pipe', 'pipe', 'inherit'];
  else if (options.interactive === true) stdio = 'inherit';
  const result = spawnSync(command, args, {
    input: options.input,
    encoding: 'utf8',
    stdio,
  });
  return {
    ok: result.status === 0,
    status: result.status,
    stdout: String(result.stdout || ''),
    stderr: String(result.stderr || ''),
    error: result.error ? String(result.error.message || result.error) : null,
  };
}

async function executeChecked(execute, command, args, options, reason) {
  const result = await execute(command, args, options);
  if (!result?.ok) {
    const detail = result?.stderr || result?.error;
    throw new Error(`${reason}${detail ? `: ${String(detail).trim().split(/\r?\n/)[0]}` : ''}`);
  }
  return result;
}

function recipientFrom(value) {
  const match = String(value || '').match(/(?:Public key:\s*|#\s*public key:\s*)(age1[a-z0-9]+)/i);
  return match ? match[1] : null;
}

async function recipientFromResult(result, file) {
  const contents = file ? await fs.readFile(file, 'utf8') : '';
  return recipientFrom(`${result?.stdout || ''}\n${result?.stderr || ''}\n${contents}`);
}

function activationDescriptor(publicKey) {
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' });
  return Object.freeze({
    schema: APPROVAL_STAMP_SCHEMA,
    type: ACTIVATION_TYPE,
    purpose: ACTIVATION_PURPOSE,
    audience: ACTIVATION_AUDIENCE,
    pinnedVerifierId: approvalStampVerifierId(publicKeyPem),
    publicKeyPem,
  });
}

function projectsDescriptor(publicKey) {
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' });
  return Object.freeze({
    schema: PROJECTS_ISSUER_SCHEMA,
    type: PROJECT_CONTEXT_TYPE,
    purpose: PROJECT_CONTEXT_PURPOSE,
    audience: PROJECT_CONTEXT_AUDIENCE,
    pinnedVerifierId: projectsVerifierId(publicKeyPem),
    publicKeyPem,
  });
}

async function removePartialVault(files) {
  const recognized = Object.entries(files)
    .filter(([name]) => name !== 'root' && name !== 'setupLock')
    .map(([, file]) => fs.rm(file, { force: true }));
  await Promise.allSettled(recognized);
  await syncDirectory(files.root);
}

async function pathExists(file) {
  try {
    await fs.access(file);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== 'ESRCH';
  }
}

async function readLockOwner(lockFile) {
  try {
    return JSON.parse(await fs.readFile(path.join(lockFile, 'owner.json'), 'utf8'));
  } catch (_) {
    return null;
  }
}

async function acquireSetupLock(files) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const token = crypto.randomUUID();
    let created = false;
    try {
      await fs.mkdir(files.setupLock, { mode: 0o700 });
      created = true;
      await durableSecurityWrite(path.join(files.setupLock, 'owner.json'), `${JSON.stringify({
        pid: process.pid,
        startedAt: new Date().toISOString(),
        token,
      })}\n`);
      await syncDirectory(files.root);
      return { token };
    } catch (error) {
      if (error.code !== 'EEXIST') {
        if (created) await fs.rm(files.setupLock, { recursive: true, force: true });
        throw error;
      }
      const owner = await readLockOwner(files.setupLock);
      if (processIsAlive(owner?.pid)) throw new Error('jarvOS security setup is already in progress');
      if (!owner) {
        let lockAge;
        try {
          lockAge = Date.now() - (await fs.stat(files.setupLock)).mtimeMs;
        } catch (statError) {
          if (statError.code === 'ENOENT') continue;
          throw statError;
        }
        if (lockAge < INCOMPLETE_LOCK_GRACE_MS) {
          throw new Error('jarvOS security setup is already in progress');
        }
      }
      const staleLock = `${files.setupLock}.stale-${process.pid}-${token}`;
      try {
        await fs.rename(files.setupLock, staleLock);
      } catch (renameError) {
        if (renameError.code === 'ENOENT') continue;
        throw renameError;
      }
      await fs.rm(staleLock, { recursive: true, force: true });
    }
  }
  throw new Error('could not acquire jarvOS security setup lock');
}

async function releaseSetupLock(files, lock) {
  const owner = await readLockOwner(files.setupLock);
  if (owner?.token === lock?.token) {
    await fs.rm(files.setupLock, { recursive: true, force: true });
  }
  await syncDirectory(files.root);
}

async function initializeSecurityVault({ root = defaultRoot(), execute = defaultExecute } = {}) {
  const files = vaultPaths(root);
  await fs.mkdir(files.root, { recursive: true, mode: 0o700 });
  await fs.chmod(files.root, 0o700);
  const lock = await acquireSetupLock(files);
  let cleanupOnFailure = false;

  try {
    if (await pathExists(files.manifest)) {
      throw new Error('jarvOS security vault is already initialized; refusing to overwrite it');
    }
    const partialFiles = await Promise.all(Object.entries(files)
      .filter(([name]) => name !== 'root' && name !== 'setupLock' && name !== 'manifest')
      .map(async ([, file]) => pathExists(file)));
    if (partialFiles.some(Boolean)) await removePartialVault(files);
    cleanupOnFailure = true;

    const secure = await executeChecked(
      execute,
      'age-plugin-se',
      ['keygen', '--access-control', 'any-biometry-or-passcode', '-o', files.secureEnclaveIdentity],
      {},
      'could not create Touch ID identity (install age and age-plugin-se first)',
    );
    await fs.chmod(files.secureEnclaveIdentity, 0o600);
    const secureRecipient = await recipientFromResult(secure, files.secureEnclaveIdentity);
    if (!secureRecipient) throw new Error('Touch ID identity did not expose its public recipient');

    const recovery = await executeChecked(
      execute,
      'age-keygen',
      [],
      {},
      'could not create recovery identity (install age first)',
    );
    const recoveryPrivate = recovery.stdout;
    if (!/^# created:|AGE-SECRET-KEY-/m.test(recoveryPrivate)) {
      throw new Error('recovery identity generator did not return private identity material');
    }
    const recoveryRecipient = await recipientFromResult(recovery);
    if (!recoveryRecipient) throw new Error('recovery identity did not expose its public recipient');
    await executeChecked(
      execute,
      'age',
      ['--passphrase', '-o', files.recoveryIdentity],
      { interactive: true, input: recoveryPrivate },
      'could not protect recovery identity',
    );
    await fs.chmod(files.recoveryIdentity, 0o600);

    const activation = crypto.generateKeyPairSync('ed25519');
    const projects = crypto.generateKeyPairSync('ed25519');
    for (const [output, privateKeyPem] of [
      [files.activationSigner, activation.privateKey.export({ type: 'pkcs8', format: 'pem' })],
      [files.projectsSigner, projects.privateKey.export({ type: 'pkcs8', format: 'pem' })],
    ]) {
      await executeChecked(
        execute,
        'age',
        ['--encrypt', '-r', secureRecipient, '-r', recoveryRecipient, '-o', output],
        { input: privateKeyPem },
        'could not encrypt signer key',
      );
      await fs.chmod(output, 0o600);
    }

    const activationPublic = activationDescriptor(activation.publicKey);
    const projectsPublic = projectsDescriptor(projects.publicKey);
    await durableSecurityWrite(files.activationDescriptor, `${JSON.stringify(activationPublic, null, 2)}\n`);
    await durableSecurityWrite(files.projectsDescriptor, `${JSON.stringify(projectsPublic, null, 2)}\n`);
    await durableSecurityWrite(files.manifest, `${JSON.stringify({
      schema: VAULT_SCHEMA,
      unlock: 'touch-id',
      recoveryCredentials: 1,
      signerPurposes: [...PURPOSES],
      activationVerifierId: activationPublic.pinnedVerifierId,
      projectsVerifierId: projectsPublic.pinnedVerifierId,
    }, null, 2)}\n`);
    await syncDirectory(files.root);
    cleanupOnFailure = false;
    return Object.freeze({
      status: 'initialized',
      root: files.root,
      unlock: 'touch-id',
      recoveryCredentials: 1,
      activationDescriptor: files.activationDescriptor,
      projectsDescriptor: files.projectsDescriptor,
      recoveryIdentity: files.recoveryIdentity,
    });
  } catch (error) {
    if (cleanupOnFailure) await removePartialVault(files);
    throw error;
  } finally {
    await releaseSetupLock(files, lock);
  }
}

async function withSigningKey({
  root = defaultRoot(),
  purpose,
  recovery = false,
  execute = defaultExecute,
  descriptor,
  useSigningKey,
} = {}) {
  if (!PURPOSES.includes(purpose)) throw new Error(`unknown signing purpose: ${String(purpose || '')}`);
  if (typeof useSigningKey !== 'function') throw new Error('signing key use callback is required');
  const files = vaultPaths(root);
  const encrypted = purpose === 'activation' ? files.activationSigner : files.projectsSigner;
  const identity = recovery ? files.recoveryIdentity : files.secureEnclaveIdentity;
  const result = await executeChecked(
    execute,
    'age',
    ['--decrypt', '-i', identity, encrypted],
    { interactive: recovery, captureStdout: true },
    `could not unlock ${purpose} signer`,
  );
  const privateKeyPem = result.stdout;
  const signingKey = crypto.createPrivateKey(privateKeyPem);
  const descriptorFile = purpose === 'activation' ? files.activationDescriptor : files.projectsDescriptor;
  const pinnedDescriptor = descriptor || JSON.parse(await fs.readFile(descriptorFile, 'utf8'));
  const publicKeyPem = crypto.createPublicKey(signingKey).export({ type: 'spki', format: 'pem' });
  const actualId = purpose === 'activation'
    ? approvalStampVerifierId(publicKeyPem)
    : projectsVerifierId(publicKeyPem);
  if (actualId !== pinnedDescriptor.pinnedVerifierId) {
    throw new Error(`${purpose} signer does not match its pinned public verifier`);
  }
  return useSigningKey(signingKey);
}

module.exports = {
  PURPOSES,
  VAULT_SCHEMA,
  defaultExecute,
  defaultRoot,
  initializeSecurityVault,
  withSigningKey,
  recipientFrom,
  vaultPaths,
};
