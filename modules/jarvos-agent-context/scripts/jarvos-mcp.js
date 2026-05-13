#!/usr/bin/env node
'use strict';

const readline = require('readline');
const {
  createNote,
  currentWork,
  hydrate,
  recall,
  startupBrief,
} = require('../src/index.js');

const TOOLS = [
  {
    name: 'jarvos_current_work',
    description: 'Return a compact jarvOS current-work summary from Paperclip.',
    inputSchema: {
      type: 'object',
      properties: {
        maxItems: { type: 'number', description: 'Maximum issue count to include.' },
        includeAllAgents: { type: 'boolean', description: 'Include issues assigned to any agent.' },
      },
    },
  },
  {
    name: 'jarvos_recall',
    description: 'Recall relevant jarvOS memory context through GBrain, optional QMD, and graph sidecar retrieval.',
    inputSchema: {
      type: 'object',
      required: ['query'],
      properties: {
        query: { type: 'string', description: 'Natural-language recall query.' },
        includeQmd: { type: 'boolean', description: 'Include QMD broad vault lookup when available.' },
        autoGraph: { type: 'boolean', description: 'Expand graph context from discovered GBrain seeds.' },
        seeds: { type: 'array', items: { type: 'string' }, description: 'Optional explicit GBrain graph seed pages.' },
      },
    },
  },
  {
    name: 'jarvos_create_note',
    description: "Create an Obsidian note, link it from today's journal, and verify the jarvOS note-capture contract.",
    inputSchema: {
      type: 'object',
      required: ['title', 'content'],
      properties: {
        title: { type: 'string', description: 'Note title and filename stem.' },
        content: { type: 'string', description: 'Markdown note body.' },
        frontmatter: { type: 'object', description: 'Additional YAML frontmatter fields.' },
        section: { type: 'string', description: 'Journal section for the wikilink.' },
      },
    },
  },
  {
    name: 'jarvos_startup_brief',
    description: 'Return a bounded startup brief with current work and optional targeted recall.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Optional targeted recall query to include.' },
        maxItems: { type: 'number', description: 'Maximum issue count to include.' },
        maxChars: { type: 'number', description: 'Maximum output characters.' },
      },
    },
  },
  {
    name: 'jarvos_hydrate',
    description: 'Return a bounded jarvOS Working Context Packet. Use this when the user says "boot jarvOS", asks to hydrate jarvOS, or wants current jarvOS working context for a chat or session.',
    inputSchema: {
      type: 'object',
      properties: {
        maxChars: { type: 'number', description: 'Maximum output characters. Defaults to about 12000.' },
        maxItems: { type: 'number', description: 'Maximum Paperclip issue count to include.' },
        includeAllAgents: { type: 'boolean', description: 'Include issues assigned to any agent.' },
        statuses: {
          type: 'array',
          items: { type: 'string' },
          description: 'Paperclip statuses to include. Defaults to in_progress and in_review.',
        },
      },
    },
  },
];

const BOOT_JARVOS_PROMPT_TEXT = [
  'Boot jarvOS for this chat.',
  '',
  'Call the jarvos_hydrate tool with maxChars: 9000, then use the returned jarvOS Working Context Packet as working context for the rest of this chat.',
  '',
  'After the tool call, reply with a concise confirmation that includes:',
  '- whether the jarvOS Working Context Packet was loaded',
  '- whether the Hydration Report was included',
  '- which source groups were included',
  '- any omissions, stale data, or missing sources reported',
  '',
  'Do not paste raw private notes, secrets, API tokens, or the full packet unless explicitly asked.',
].join('\n');

const PROMPTS = [
  {
    name: 'boot_jarvos',
    title: 'Boot jarvOS',
    description: 'Hydrate the current chat with the bounded jarvOS Working Context Packet.',
    arguments: [
      {
        name: 'maxChars',
        description: 'Optional maximum character budget for the hydration packet. Defaults to 9000 for Claude Desktop.',
        required: false,
      },
    ],
  },
];

function write(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function textResult(text, isError = false) {
  return {
    content: [{ type: 'text', text: String(text || '') }],
    isError,
  };
}

async function callTool(name, args = {}) {
  if (name === 'jarvos_current_work') {
    const result = await currentWork(args);
    return textResult(result.markdown, !result.ok);
  }
  if (name === 'jarvos_recall') {
    const result = recall(args);
    return textResult(result.markdown, !result.ok);
  }
  if (name === 'jarvos_create_note') {
    const result = createNote(args);
    return textResult(result.markdown, !result.ok);
  }
  if (name === 'jarvos_startup_brief') {
    const result = await startupBrief(args);
    return textResult(result.markdown, !result.ok);
  }
  if (name === 'jarvos_hydrate') {
    const result = await hydrate(args);
    return textResult(result.markdown, !result.ok);
  }
  throw new Error(`Unknown tool: ${name}`);
}

function promptResult(name, args = {}) {
  if (name !== 'boot_jarvos') {
    const error = new Error(`Unknown prompt: ${name}`);
    error.code = -32602;
    throw error;
  }

  const maxChars = Number(args.maxChars || 9000);
  const text = Number.isFinite(maxChars) && maxChars > 0
    ? BOOT_JARVOS_PROMPT_TEXT.replace('maxChars: 9000', `maxChars: ${Math.floor(maxChars)}`)
    : BOOT_JARVOS_PROMPT_TEXT;

  return {
    description: 'Boot jarvOS manual hydration for this chat.',
    messages: [
      {
        role: 'user',
        content: { type: 'text', text },
      },
    ],
  };
}

async function handle(message) {
  if (!message || typeof message !== 'object') return;
  const { id, method, params } = message;
  if (!id && String(method || '').startsWith('notifications/')) return;

  try {
    if (method === 'initialize') {
      write({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: params?.protocolVersion || '2024-11-05',
          capabilities: { tools: {}, prompts: {} },
          serverInfo: { name: 'jarvos', version: '0.1.0' },
        },
      });
      return;
    }

    if (method === 'tools/list') {
      write({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
      return;
    }

    if (method === 'prompts/list') {
      write({ jsonrpc: '2.0', id, result: { prompts: PROMPTS } });
      return;
    }

    if (method === 'prompts/get') {
      const result = promptResult(params?.name, params?.arguments || {});
      write({ jsonrpc: '2.0', id, result });
      return;
    }

    if (method === 'tools/call') {
      const result = await callTool(params?.name, params?.arguments || {});
      write({ jsonrpc: '2.0', id, result });
      return;
    }

    write({
      jsonrpc: '2.0',
      id,
      error: { code: -32601, message: `Method not found: ${method}` },
    });
  } catch (error) {
    write({
      jsonrpc: '2.0',
      id,
      error: { code: error.code || -32000, message: error.message || String(error) },
    });
  }
}

async function runCliCommand() {
  const command = process.argv[2];
  if (command === 'startup-brief') {
    const query = process.argv.slice(3).join(' ').trim();
    const result = await startupBrief({ query });
    process.stdout.write(`${result.markdown}\n`);
    return true;
  }
  if (command === 'hydrate') {
    const maxCharsIndex = process.argv.indexOf('--max-chars');
    const maxChars = maxCharsIndex >= 0 ? Number(process.argv[maxCharsIndex + 1]) : undefined;
    const result = await hydrate({ maxChars });
    process.stdout.write(`${result.markdown}\n`);
    return true;
  }
  return false;
}

async function main() {
  if (await runCliCommand()) return;

  const rl = readline.createInterface({ input: process.stdin });
  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let message;
    try {
      message = JSON.parse(trimmed);
    } catch (error) {
      write({ jsonrpc: '2.0', error: { code: -32700, message: `Parse error: ${error.message}` } });
      return;
    }
    handle(message);
  });
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exit(1);
  });
}

module.exports = { TOOLS, callTool, handle, textResult };
module.exports.BOOT_JARVOS_PROMPT_TEXT = BOOT_JARVOS_PROMPT_TEXT;
module.exports.PROMPTS = PROMPTS;
module.exports.promptResult = promptResult;
