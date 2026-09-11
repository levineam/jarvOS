'use strict';

const fs = require('fs');
const path = require('path');
const paperclip = require('./paperclip');

function dirStatus(dir, glob = '.md') {
  try {
    const count = fs.readdirSync(dir).filter((f) => f.endsWith(glob)).length;
    return { ok: true, count };
  } catch (err) {
    return { ok: false, error: err.code || err.message };
  }
}

async function services(cfg, todayDate) {
  const journal = dirStatus(cfg.vault.journalDir);
  const todayFile = path.join(cfg.vault.journalDir, `${todayDate}.md`);
  const notes = dirStatus(cfg.vault.notesDir);
  const ontology = dirStatus(cfg.ontologyDir);
  const memoryIndex = fs.existsSync(cfg.memory.indexFile);
  const memoryDaily = dirStatus(cfg.memory.dailyDir);
  const mcpScript = path.join(cfg.jarvosRepo, 'modules', 'jarvos-agent-context', 'scripts', 'jarvos-mcp.js');
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
      ok: journal.ok && fs.existsSync(todayFile),
      detail: journal.ok
        ? `${journal.count} days · today ${fs.existsSync(todayFile) ? 'present' : 'MISSING'}`
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
      ok: fs.existsSync(mcpScript),
      detail: fs.existsSync(mcpScript) ? 'jarvos-mcp.js installed' : 'adapter script not found',
      endpoint: mcpScript,
    },
  ];
}

module.exports = { services };
