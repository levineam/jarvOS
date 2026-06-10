'use strict';

const journal = require('./adapters/journal');
const notes = require('./adapters/notes');
const paperclip = require('./adapters/paperclip');

const NEEDS_YOU_STATUSES = new Set(['blocked', 'in_review']);
const MOVING_STATUSES = new Set(['in_progress']);
const RECENT_DONE_HOURS = 48;

function localDate() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function sectionItems(day, title) {
  if (!day) return [];
  const s = day.sections.find((x) => x.title.toLowerCase().includes(title.toLowerCase()));
  return s && !s.empty ? s.items : [];
}

// Deterministic plain-English brief: what's moving, what needs you, what changed.
async function brief(cfg) {
  const date = localDate();
  const day = journal.today(cfg.vault.journalDir, date);

  let allIssues = [];
  let agents = [];
  let paperclipError = null;
  try {
    [allIssues, agents] = await Promise.all([
      paperclip.issues(cfg.paperclip),
      paperclip.agents(cfg.paperclip),
    ]);
  } catch (err) {
    paperclipError = err.message;
  }

  const agentName = new Map(agents.map((a) => [a.id, a.name]));
  const decorate = (i) => ({ ...i, assignee: agentName.get(i.assigneeAgentId) || null });

  const moving = allIssues.filter((i) => MOVING_STATUSES.has(i.status)).map(decorate);
  const needsYou = allIssues.filter((i) => NEEDS_YOU_STATUSES.has(i.status)).map(decorate);
  const doneCutoff = Date.now() - RECENT_DONE_HOURS * 3600 * 1000;
  const recentlyDone = allIssues
    .filter((i) => i.status === 'done' && i.updatedAt && Date.parse(i.updatedAt) > doneCutoff)
    .map(decorate)
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));

  return {
    date,
    paperclipError,
    calendar: sectionItems(day, 'Calendar'),
    reminders: sectionItems(day, 'Reminders'),
    flagged: sectionItems(day, 'Flagged'),
    ideas: sectionItems(day, 'Ideas'),
    journalEntry: sectionItems(day, 'Journal Entry'),
    inbox: sectionItems(day, 'Paperclip Inbox'),
    moving,
    needsYou,
    recentlyDone: recentlyDone.slice(0, 10),
    recentNotes: notes.recent(cfg.vault.notesDir, { limit: 8, sinceHours: 72 }),
    agents,
  };
}

module.exports = { brief, localDate };
