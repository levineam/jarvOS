'use strict';

const fs = require('fs');
const path = require('path');
const paperclip = require('./paperclip');

function dirStatus(dir, glob = '.md') {
  if (!dir) return { ok: false, error: 'not configured' };
  try {
    const count = fs.readdirSync(dir).filter((f) => f.endsWith(glob)).length;
    return { ok: true, count };
  } catch (err) {
    return { ok: false, error: err.code || err.message };
  }
}

async function services(cfg, todayDate) {
  const journal = dirStatus(cfg.vault.journalDir);
  const todayFile = cfg.vault.journalDir ? path.join(cfg.vault.journalDir, `${todayDate}.md`) : null;
  const notes = dirStatus(cfg.vault.notesDir);
  const ontology = dirStatus(cfg.ontologyDir);
  const memoryIndex = Boolean(cfg.memory.indexFile && fs.existsSync(cfg.memory.indexFile));
  const memoryDaily = dirStatus(cfg.memory.dailyDir);
  const mcpScript = cfg.jarvosRepo && path.join(cfg.jarvosRepo, 'modules', 'jarvos-agent-context', 'scripts', 'jarvos-mcp.js');
  const pc = await paperclip.ping(cfg.paperclip);

  return [
    {
      key: 'paperclip',
      name: 'Paperclip',
      kind: 'Work tracker',
      ok: pc.ok,
      detail: pc.ok ? `API up · ${pc.latencyMs}ms` : pc.error,
      endpoint: cfg.paperclip.url,
    },
    {
      key: 'journal',
      name: 'Journal',
      kind: 'Daily control room',
      ok: journal.ok && Boolean(todayFile && fs.existsSync(todayFile)),
      detail: journal.ok
        ? `${journal.count} days · today ${todayFile && fs.existsSync(todayFile) ? 'present' : 'MISSING'}`
        : journal.error,
      endpoint: cfg.vault.journalDir,
    },
    {
      key: 'notes',
      name: 'Notes vault',
      kind: 'Durable knowledge',
      ok: notes.ok,
      detail: notes.ok ? `${notes.count} notes (Obsidian-compatible)` : notes.error,
      endpoint: cfg.vault.notesDir,
    },
    {
      key: 'ontology',
      name: 'Ontology spine',
      kind: 'Meaning layer',
      ok: ontology.ok && ontology.count > 0,
      detail: ontology.ok ? `${ontology.count} spine files` : ontology.error,
      endpoint: cfg.ontologyDir,
    },
    {
      key: 'memory',
      name: 'Memory',
      kind: 'Durable agent state',
      ok: memoryIndex,
      detail: memoryIndex
        ? `MEMORY.md present · ${memoryDaily.ok ? memoryDaily.count + ' daily files' : 'no daily dir'}`
        : 'MEMORY.md missing',
      endpoint: cfg.memory.indexFile,
    },
    {
      key: 'agent-context',
      name: 'Agent Context MCP',
      kind: 'Runtime adapter',
      ok: Boolean(mcpScript && fs.existsSync(mcpScript)),
      detail: mcpScript && fs.existsSync(mcpScript) ? 'jarvos-mcp.js installed' : 'adapter script not configured',
      endpoint: mcpScript,
    },
  ];
}

module.exports = { services };
