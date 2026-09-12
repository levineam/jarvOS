'use strict';

async function createWriteTools(cfg) {
  const { tool } = await import('ai');
  const { z } = await import('zod');
  const notes = require('../../adapters/notes');
  const journal = require('../../adapters/journal');
  const paperclip = require('../../adapters/paperclip');
  const unavailable = (name) => ({ available: false, reason: `${name} is not configured` });
  const has = (value) => typeof value === 'string' && value.trim() !== '';

  return {
    create_note: tool({
      description: 'Create a new markdown note in the notes vault. Requires user approval.',
      inputSchema: z.object({
        title: z.string().min(1),
        content: z.string().min(1),
      }),
      execute: async ({ title, content }) => has(cfg.vault?.notesDir) ? notes.create(cfg.vault.notesDir, title, content) : unavailable('Notes vault'),
    }),
    append_journal: tool({
      description: 'Append a bullet to a journal day. Additive only. Requires user approval.',
      inputSchema: z.object({
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        section: z.string().default('Agent Notes'),
        bullet: z.string().min(1),
      }),
      execute: async ({ date, section, bullet }) => has(cfg.vault?.journalDir) ? journal.appendBullet(cfg.vault.journalDir, date, section, bullet) : unavailable('Journal'),
    }),
    create_paperclip_issue: tool({
      description: 'Create a Paperclip issue. Requires user approval.',
      inputSchema: z.object({
        title: z.string().min(1),
        description: z.string().default(''),
        priority: z.enum(['critical', 'high', 'medium', 'low']).default('medium'),
        projectId: z.string().optional(),
      }),
      execute: async ({ title, description, priority, projectId }) =>
        !paperclip.configured(cfg.paperclip) ? unavailable('Paperclip') : paperclip.createIssue(cfg.paperclip, {
          title,
          description,
          priority,
          projectId: projectId || cfg.paperclip.projectId,
          status: 'todo',
        }),
    }),
    update_paperclip_issue: tool({
      description: 'Update an existing Paperclip issue. Requires user approval.',
      inputSchema: z.object({
        id: z.string().min(1),
        title: z.string().optional(),
        description: z.string().optional(),
        status: z.enum(['backlog', 'todo', 'in_progress', 'in_review', 'done', 'blocked', 'cancelled']).optional(),
        priority: z.enum(['critical', 'high', 'medium', 'low']).optional(),
        comment: z.string().optional(),
      }),
      execute: async ({ id, ...patch }) => paperclip.configured(cfg.paperclip) ? paperclip.updateIssue(cfg.paperclip, id, patch) : unavailable('Paperclip'),
    }),
  };
}

module.exports = { createWriteTools };
