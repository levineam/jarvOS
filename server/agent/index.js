'use strict';

const crypto = require('crypto');
const credentials = require('./credentials');
const providers = require('./providers');
const { createReadTools } = require('./tools/read');
const { createWriteTools } = require('./tools/write');
const { createDispatchTools } = require('./tools/dispatch');
const { readJson, pipeWebResponse, httpError } = require('../http-utils');

const GATED_TOOLS = {
  create_note: 'user-approval',
  append_journal: 'user-approval',
  create_paperclip_issue: 'user-approval',
  update_paperclip_issue: 'user-approval',
  dispatch_runtime: 'user-approval',
};

const TOOL_APPROVAL_SECRET =
  process.env.JARVOS_TOOL_APPROVAL_SECRET ||
  process.env.TOOL_APPROVAL_SECRET ||
  crypto.randomBytes(32);

function instructions() {
  return [
    'You are the jarvOS Desktop Chat agent.',
    'Answer using the user\'s local jarvOS substrate through tools: journal, notes, memory, ontology, and Paperclip.',
    'Read tools may run automatically. Write, delete, Paperclip mutation, and runtime dispatch tools require explicit user approval.',
    'Vault writes are additive only: create new notes or append journal bullets; never rewrite or delete existing vault content.',
    'When a write or dispatch is needed, draft a concise artifact payload and wait for approval. Do not claim a write happened until the approved tool result confirms it.',
    'For heavy implementation work, use dispatch_runtime with runtime "openclaw" so clawd/Paperclip gates carry execution.',
  ].join('\n');
}

async function buildAgent(cfg, { modelId, apiKey }) {
  const { ToolLoopAgent, stepCountIs } = await import('ai');
  const [readTools, writeTools, dispatchTools, model] = await Promise.all([
    createReadTools(cfg),
    createWriteTools(cfg),
    createDispatchTools(cfg),
    providers.resolveLanguageModel({ modelId, apiKey }),
  ]);
  return new ToolLoopAgent({
    model,
    instructions: instructions(),
    tools: { ...readTools, ...writeTools, ...dispatchTools },
    toolApproval: GATED_TOOLS,
    experimental_toolApprovalSecret: TOOL_APPROVAL_SECRET,
    stopWhen: stepCountIs(20),
  });
}

async function handleChat(req, res, cfg) {
  const body = await readJson(req, { limit: 2_000_000 });
  const resolved = credentials.resolveOpenAIKey();
  if (!resolved.key) {
    throw httpError(412, 'Add an OpenAI API key before chatting');
  }
  const { createAgentUIStreamResponse } = await import('ai');
  const agent = await buildAgent(cfg, { modelId: body.modelId, apiKey: resolved.key });
  const abortController = new AbortController();
  req.on('close', () => abortController.abort());
  const webResponse = await createAgentUIStreamResponse({
    agent,
    uiMessages: body.messages || [],
    abortSignal: abortController.signal,
    options: {
      providerOptions: providers.buildProviderOptions({ reasoningEffort: body.reasoningEffort }),
    },
  });
  await pipeWebResponse(webResponse, res);
}

module.exports = {
  GATED_TOOLS,
  buildAgent,
  handleChat,
  listModels: providers.listModels,
};
