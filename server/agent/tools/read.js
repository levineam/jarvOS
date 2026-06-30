'use strict';

async function createReadTools(cfg) {
  const { tool } = await import('ai');
  const { z } = await import('zod');
  const journal = require('../../adapters/journal');
  const notes = require('../../adapters/notes');
  const paperclip = require('../../adapters/paperclip');
  const ontology = require('../../adapters/ontology');
  const memory = require('../../adapters/memory');

  return {
    search_notes: tool({
      description: 'Search local Obsidian-compatible notes by title or content.',
      inputSchema: z.object({ query: z.string().default(''), limit: z.number().min(1).max(25).default(10) }),
      execute: async ({ query, limit }) => notes.list(cfg.vault.notesDir, { q: query, limit }),
    }),
    read_note: tool({
      description: 'Read one local note by title.',
      inputSchema: z.object({ title: z.string().min(1) }),
      execute: async ({ title }) => notes.read(cfg.vault.notesDir, title) || { found: false, title },
    }),
    read_journal_day: tool({
      description: 'Read one journal day by YYYY-MM-DD date.',
      inputSchema: z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }),
      execute: async ({ date }) => journal.readDay(cfg.vault.journalDir, date) || { found: false, date },
    }),
    recent_journal: tool({
      description: 'Read recent journal days, newest first.',
      inputSchema: z.object({ limit: z.number().min(1).max(14).default(5) }),
      execute: async ({ limit }) => journal.stream(cfg.vault.journalDir, { limit }),
    }),
    read_memory: tool({
      description: 'Read the jarvOS durable memory index and recent daily memory files.',
      inputSchema: z.object({ dailyFile: z.string().optional() }),
      execute: async ({ dailyFile }) => dailyFile
        ? memory.readDaily(cfg.memory, dailyFile) || { found: false, dailyFile }
        : memory.index(cfg.memory),
    }),
    read_ontology: tool({
      description: 'Read the ontology meaning spine.',
      inputSchema: z.object({}),
      execute: async () => ontology.spine(cfg.ontologyDir),
    }),
    list_paperclip_issues: tool({
      description: 'List current Paperclip issues visible to jarvOS.',
      inputSchema: z.object({ limit: z.number().min(1).max(50).default(20) }),
      execute: async ({ limit }) => (await paperclip.issues(cfg.paperclip)).slice(0, limit),
    }),
    read_paperclip_issue: tool({
      description: 'Read one Paperclip issue by id or identifier.',
      inputSchema: z.object({ id: z.string().min(1) }),
      execute: async ({ id }) => paperclip.issueDetail(cfg.paperclip, id),
    }),
  };
}

module.exports = { createReadTools };
