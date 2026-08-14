'use strict';

const { runTakeIssueToDone } = require('../features/orchestrator');

const NATIVE_WORKFLOW_SCHEMA_VERSION = 'jarvos-native-workflow/v1';

function createNativeWorkflowAdapter(options = {}) {
  const execute = options.runTakeIssueToDone || runTakeIssueToDone;
  if (typeof execute !== 'function') throw new Error('public native workflow executor is required');
  return Object.freeze({
    schemaVersion: NATIVE_WORKFLOW_SCHEMA_VERSION,
    async plan(invocation) {
      if (typeof options.plan !== 'function') throw new Error('public native planning dependency is unavailable');
      return options.plan(invocation);
    },
    async work(invocation) {
      if (typeof options.work === 'function') return options.work(invocation);
      return execute({ ...invocation.input, workRunId: invocation.workRunId, canonicalWorktree: invocation.canonicalWorktree }, options.adapters || {});
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
