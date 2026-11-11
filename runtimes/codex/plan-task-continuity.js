#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const { readPlanTaskContext, selectPlanTask, checkpointPlanTask, renderPlanTaskContext } = require('../../modules/jarvos-agent-context/src/projects-files');

async function main() {
  const action = process.argv[2];
  // A profile can add this reader beside its selected managed hook without
  // replacing the dispatcher, touching a selected package or starting services.
  if (action === 'hook') {
    const raw = fs.readFileSync(0, 'utf8');
    if (raw.length > 1_000_000) return {};
    const input = JSON.parse(raw);
    if (!['SessionStart', 'UserPromptSubmit'].includes(input.hook_event_name)
      || (input.hook_event_name === 'SessionStart' && input.source && !['startup', 'resume', 'compact'].includes(input.source))) return {};
    if (input.hook_event_name === 'SessionStart' && input.source === 'compact'
      && (input.agent_id || typeof input.session_id !== 'string'
        || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.session_id)
        || (process.env.CODEX_THREAD_ID !== undefined && process.env.CODEX_THREAD_ID !== input.session_id))) return {};
    const context = await readPlanTaskContext({ directory: process.env.JARVOS_PROJECTS_DIR, sessionId: input.session_id });
    const markdown = renderPlanTaskContext(context);
    return markdown ? { hookSpecificOutput: { hookEventName: input.hook_event_name, additionalContext: markdown }, suppressOutput: true } : {};
  }
  const actions = { read: readPlanTaskContext, select: selectPlanTask, checkpoint: checkpointPlanTask };
  if (!Object.hasOwn(actions, action)) throw new Error('Unsupported task pointer action');
  const raw = fs.readFileSync(0, 'utf8');
  if (raw.length > 16_000) throw new Error('Task pointer input is too large');
  const input = raw.trim() ? JSON.parse(raw) : {};
  const allowed = action === 'read' ? [] : ['project', 'task', 'expectedState', 'expectedRevision'];
  if (!input || Array.isArray(input) || typeof input !== 'object' || Object.keys(input).some((key) => !allowed.includes(key))) throw new Error('Unsupported task pointer fields');
  return actions[action]({ ...input, directory: process.env.JARVOS_PROJECTS_DIR, sessionId: process.env.CODEX_THREAD_ID });
}

if (require.main === module) main().then((result) => process.stdout.write(`${JSON.stringify(result)}\n`)).catch(() => {
  process.stdout.write(`${JSON.stringify({ status: 'reconcile', code: 'PMS_POINTER_INPUT_UNAVAILABLE', effectsAuthorized: false })}\n`);
  process.exitCode = 1;
});

module.exports = { main };
