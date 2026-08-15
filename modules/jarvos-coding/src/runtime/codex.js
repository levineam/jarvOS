'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const { buildLiveCodingAdapters } = require('../adapters/live');
const { createFileWorkRunStore } = require('../features/work-run-store');
const { loadRepositoryRegistry } = require('./repository-registry');
const { createManagedCodingWorkflow } = require('../features/workflow');
const { createNativeWorkflowAdapter } = require('../adapters/native-workflow');

const CODEX_RUNTIME_SCHEMA_VERSION = 'jarvos-coding-codex-runtime/v1';
const SUBJECT = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
function digest(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function canonicalWorktree(entry, requested) {
  // Worktree selection is controller-owned.  This U1 boundary intentionally
  // does not interpret a caller's filesystem path, even if it happens to be
  // inside a registered root.
  if (requested !== undefined && requested !== null) throw new Error('model-supplied worktree paths are not accepted');
  return entry.root;
}
function createCodexRuntime(options = {}) {
  const registry = options.registry || loadRepositoryRegistry(options.registryPath, { ownerUid: options.ownerUid });
  function resolveRequest(input = {}) {
    if (!input || typeof input !== 'object') throw new Error('coding request must be an object');
    for (const key of ['root', 'repositoryRoot', 'stateRoot', 'registryPath', 'provider', 'executable', 'command', 'credential', 'credentialReferences']) {
      if (Object.prototype.hasOwnProperty.call(input, key)) throw new Error(`model-supplied ${key} is not accepted`);
    }
    if (!OPAQUE_ID.test(input.repositoryId || '')) throw new Error('repositoryId is required');
    if (typeof input.subjectKey !== 'string' || !SUBJECT.test(input.subjectKey)) throw new Error('subjectKey must be a safe stable identifier');
    const repository = registry.resolve(input.repositoryId);
    if (input.agentSelectable !== false && !repository.agentSelectable) throw new Error('repository is not agent-selectable');
    const workRunId = input.workRunId || `run_${digest(`${repository.repositoryId}\0${input.subjectKey}`).slice(0, 24)}`;
    if (!OPAQUE_ID.test(workRunId)) throw new Error('workRunId must be opaque');
    const qualifiedSubject = `${repository.repositoryId}:${input.subjectKey}`;
    const worktree = canonicalWorktree(repository, input.worktree);
    const store = createFileWorkRunStore(repository.stateRoot);
    const existing = store.getWorkRun(workRunId, { public: false });
    if (existing && existing.subjectKey !== qualifiedSubject) throw new Error('workRunId belongs to a different repository-qualified subject');
    if (existing?.canonicalWorktree && existing.canonicalWorktree !== worktree) throw new Error('work run canonical worktree no longer matches repository authority');
    const liveAdapters = buildLiveCodingAdapters({ ...(options.liveAdapters || {}), repoRootDir: repository.root, worktreeRoot: repository.worktreePolicy.root, repo: repository.tracker.repo });
    const nativeAdapter = options.nativeAdapter || createNativeWorkflowAdapter({ ...(options.nativeWorkflow || {}), adapters: liveAdapters });
    const managedWorkflow = createManagedCodingWorkflow({
      ...(options.managedWorkflow || {}),
      workRunStore: store,
      nativeAdapter,
      finishAdapters: options.managedWorkflow?.finishAdapters || liveAdapters,
      manifestPath: options.managedWorkflow?.manifestPath || path.resolve(__dirname, '../../providers/compound-engineering.json'),
      acceptancePolicy: repository.acceptancePolicy,
      ownerId: options.ownerId || 'jarvos-coding',
    });
    return Object.freeze({ repository, repositoryId: repository.repositoryId, subjectKey: qualifiedSubject, workRunId, canonicalWorktree: worktree, store, managedWorkflow,
      public: Object.freeze({ version: CODEX_RUNTIME_SCHEMA_VERSION, repository: { repositoryId: repository.repositoryId, label: repository.publicLabel }, subjectKey: qualifiedSubject, workRunId }),
      adapters: liveAdapters,
    });
  }
  return Object.freeze({ schemaVersion: CODEX_RUNTIME_SCHEMA_VERSION, resolveRequest, listRepositories: () => registry.listPublic(), health: () => ({ version: CODEX_RUNTIME_SCHEMA_VERSION, status: 'installed-but-unwired', registryGeneration: registry.generation, repositories: registry.listPublic() }) });
}
module.exports = { CODEX_RUNTIME_SCHEMA_VERSION, createCodexRuntime };
