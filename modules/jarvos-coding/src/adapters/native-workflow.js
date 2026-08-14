'use strict';

const { runTakeIssueToDone } = require('../features/orchestrator');

const NATIVE_WORKFLOW_SCHEMA_VERSION = 'jarvos-native-workflow/v1';
const NATIVE_PLAN_SCHEMA_VERSION = 'jarvos-native-plan/v1';

function createNativeWorkflowAdapter(options = {}) {
  const execute = options.runTakeIssueToDone || runTakeIssueToDone;
  if (typeof execute !== 'function') throw new Error('public native workflow executor is required');
  return Object.freeze({
    schemaVersion: NATIVE_WORKFLOW_SCHEMA_VERSION,
    async plan(invocation) {
      if (typeof options.plan === 'function') return options.plan(invocation);
      // The native route must remain usable when the optional Compound
      // Engineering provider is unavailable. This is deliberately a bounded
      // planning scaffold: it records the stable task digest and leaves the
      // implementation packet to the managed acceptance boundary rather than
      // inventing files, commands, or completion evidence.
      const planDigest = invocation?.input?.digest;
      return {
        schemaVersion: NATIVE_PLAN_SCHEMA_VERSION,
        planDigest,
        summary: 'Implement the requested change in the owner-provisioned repository.',
        steps: [{
          id: 'step_01',
          description: 'Implement the requested change in the owner-provisioned repository.',
        }],
      };
    },
    async work(invocation) {
      if (typeof options.work === 'function') return options.work(invocation);
      return execute({
        ...invocation.input,
        issueIdentifier: invocation.issueIdentifier || invocation.input?.issueIdentifier,
        workRunId: invocation.workRunId,
        canonicalWorktree: invocation.canonicalWorktree,
      }, options.adapters || {});
    },
    async reconcileWork(invocation) {
      if (typeof options.reconcileWork !== 'function') return { safe: false, reasonCode: 'authoritative_reconciliation_unavailable' };
      return options.reconcileWork(invocation);
    },
    async verify(invocation) {
      if (typeof options.verify !== 'function') throw new Error('public authoritative verification dependency is unavailable');
      return options.verify(invocation);
    },
  });
}

module.exports = { NATIVE_WORKFLOW_SCHEMA_VERSION, createNativeWorkflowAdapter };
