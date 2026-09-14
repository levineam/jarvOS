'use strict';

const MODELS = [
  {
    id: 'openai:gpt-5.5',
    provider: 'openai',
    model: 'gpt-5.5',
    label: 'GPT-5.5',
    reasoningEfforts: ['minimal', 'low', 'medium', 'high'],
  },
];

const DEFAULT_MODEL_ID = MODELS[0].id;
const DEFAULT_EFFORT = 'medium';

function listModels() {
  return { models: MODELS, defaultModelId: DEFAULT_MODEL_ID, defaultReasoningEffort: DEFAULT_EFFORT };
}

function normalizeReasoningEffort(value) {
  return ['minimal', 'low', 'medium', 'high'].includes(value) ? value : DEFAULT_EFFORT;
}

function parseModelId(modelId = DEFAULT_MODEL_ID) {
  const model = MODELS.find((m) => m.id === modelId);
  if (!model) {
    const err = new Error(`unknown model "${modelId}"`);
    err.status = 400;
    throw err;
  }
  return model;
}

async function resolveLanguageModel({ modelId = DEFAULT_MODEL_ID, apiKey }) {
  const model = parseModelId(modelId);
  if (model.provider !== 'openai') {
    const err = new Error(`provider "${model.provider}" is not available in v1`);
    err.status = 400;
    throw err;
  }
  const { createOpenAI } = await import('@ai-sdk/openai');
  const openai = createOpenAI({ apiKey });
  return openai(model.model);
}

function buildProviderOptions({ reasoningEffort } = {}) {
  return {
    openai: {
      reasoningEffort: normalizeReasoningEffort(reasoningEffort),
    },
  };
}

module.exports = {
  DEFAULT_MODEL_ID,
  DEFAULT_EFFORT,
  listModels,
  parseModelId,
  normalizeReasoningEffort,
  resolveLanguageModel,
  buildProviderOptions,
};
