#!/usr/bin/env node
/**
 * spine-synthesis.js — deterministic backbone for "what should I explore next?".
 *
 * The Journal is the chronological spine. Synthesis rides it: take recently-active
 * journal entries, follow their wiki-links into the durable note graph, and use the
 * notes' concepts (from the knowledge-optimizer artifacts) to (a) cluster recent
 * threads and (b) surface "bridge" concepts that connect two or more separate recent
 * threads — high-leverage things to explore or expand.
 *
 * This module is PURE: callers inject the journal entries and a title->concepts map,
 * so it has no fs/LLM deps and is fully testable. The morning synthesis job wires it
 * to the vault + optimizer artifacts and hands the ranked candidates to an LLM for
 * phrasing — the LLM works over a tight, deterministic candidate set, not the whole
 * vault.
 */

'use strict';

const NOTES_SECTIONS = ['## 📝 Notes', '## ✅ Decisions'];

function extractLinks(md) {
  const out = [];
  for (const m of String(md || '').matchAll(/\[\[([^\]]+)\]\]/g)) {
    const t = m[1].split('|')[0].split('#')[0].trim();
    if (t) out.push(t);
  }
  return out;
}

/**
 * From recent journal entries ([{date, content}], any order), collect the active set:
 * which notes were linked, on which days.
 * Returns { noteDays: Map<title, Set<date>>, notes: string[] (most-recent first) }.
 */
function extractSpineActivity(journalEntries = []) {
  const noteDays = new Map();
  const order = [];
  const sorted = [...journalEntries].sort((a, b) => String(b.date).localeCompare(String(a.date)));
  for (const entry of sorted) {
    for (const title of extractLinks(entry.content)) {
      if (!noteDays.has(title)) { noteDays.set(title, new Set()); order.push(title); }
      noteDays.get(title).add(entry.date);
    }
  }
  return { noteDays, notes: order };
}

/** Build concept<->note indexes from [{title, concepts:[...]}]. */
function buildConceptIndex(notes = []) {
  const conceptToNotes = new Map();
  const noteToConcepts = new Map();
  for (const { title, concepts = [] } of notes) {
    const set = new Set(concepts.filter(Boolean));
    noteToConcepts.set(title, set);
    for (const c of set) {
      if (!conceptToNotes.has(c)) conceptToNotes.set(c, new Set());
      conceptToNotes.get(c).add(title);
    }
  }
  return { conceptToNotes, noteToConcepts };
}

/** note->note edges weighted by number of shared concepts (within `titles`). */
function relatedByConcept(titles, index) {
  const list = [...titles];
  const edges = [];
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const a = index.noteToConcepts.get(list[i]) || new Set();
      const b = index.noteToConcepts.get(list[j]) || new Set();
      let shared = 0;
      for (const c of a) if (b.has(c)) shared += 1;
      if (shared > 0) edges.push({ a: list[i], b: list[j], shared });
    }
  }
  return edges.sort((x, y) => y.shared - x.shared);
}

/**
 * Rank "explore/expand" candidates: concepts that bridge two or more of the recently
 * active notes. A concept connecting multiple separate recent threads is a high-value
 * thing to explore. Returns [{ concept, notes:[...], recentCount, daySpan, score }].
 */
function exploreCandidates(activity, index, { limit = 5 } = {}) {
  const recent = new Set(activity.notes);
  const scored = [];
  for (const [concept, notesSet] of index.conceptToNotes.entries()) {
    const recentNotes = [...notesSet].filter((t) => recent.has(t));
    if (recentNotes.length < 2) continue; // must bridge at least two recent threads
    const days = new Set();
    for (const t of recentNotes) for (const d of (activity.noteDays.get(t) || [])) days.add(d);
    const score = recentNotes.length * 2 + days.size;
    scored.push({ concept, notes: recentNotes, recentCount: recentNotes.length, daySpan: days.size, score });
  }
  return scored.sort((a, b) => b.score - a.score || b.recentCount - a.recentCount).slice(0, limit);
}

/** Convenience: full deterministic synthesis from journals + concept map. */
function synthesize({ journalEntries = [], notes = [], limit = 5 } = {}) {
  const activity = extractSpineActivity(journalEntries);
  const index = buildConceptIndex(notes);
  return {
    activeNotes: activity.notes,
    related: relatedByConcept(activity.notes, index),
    explore: exploreCandidates(activity, index, { limit }),
  };
}

module.exports = {
  NOTES_SECTIONS,
  extractLinks,
  extractSpineActivity,
  buildConceptIndex,
  relatedByConcept,
  exploreCandidates,
  synthesize,
};
