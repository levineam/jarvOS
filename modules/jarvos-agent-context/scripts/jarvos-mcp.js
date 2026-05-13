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
    description: 'Return a bounded jarvOS working-context hydration packet for Codex session startup.',
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
          capabilities: { tools: {} },
          serverInfo: { name: 'jarvos', version: '0.1.0' },
        },
      });
      return;
    }

    if (method === 'tools/list') {
      write({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
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
      error: { code: -32000, message: error.message || String(error) },
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
