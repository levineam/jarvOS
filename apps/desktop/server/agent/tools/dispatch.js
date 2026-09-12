'use strict';

async function createDispatchTools(cfg) {
  const { tool } = await import('ai');
  const { z } = await import('zod');
  const openclaw = require('../../adapters/runtime/openclaw');

  return {
    dispatch_runtime: tool({
      description: 'Dispatch heavy work to an execution runtime. v1 supports openclaw. Requires user approval.',
      inputSchema: z.object({
        runtime: z.enum(['openclaw', 'codex', 'claude-code']),
        title: z.string().min(1),
        task: z.string().min(1),
        plan: z.string().default(''),
      }),
      execute: async ({ runtime, title, task, plan }) => {
        if (runtime !== 'openclaw') {
          return { dispatched: false, runtime, reason: `${runtime} adapter is not available in v1` };
        }
        return openclaw.dispatch(cfg.paperclip, { title, task, plan });
      },
    }),
  };
}

module.exports = { createDispatchTools };
