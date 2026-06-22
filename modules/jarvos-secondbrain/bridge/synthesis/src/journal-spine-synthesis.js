#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const { resolveConfig } = require('../../config');

const DEFAULT_WINDOW_DAYS = 7;
const DEFAULT_LIMIT = 12;
const VERSION = 1;

function slugify(value) {
  const slug = String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 96);
  return slug || 'untitled';
}

function normalizeTitle(value) {
  return String(value || '')
    .replace(/\.md$/i, '')
    .trim()
    .toLowerCase();
}

function ymdToTime(value) {
  const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

function dateFromOffset(baseYmd, offsetDays) {
  const base = ymdToTime(baseYmd);
  if (base === null) throw new Error(`Invalid date: ${baseYmd}`);
  const date = new Date(base + offsetDays * 24 * 60 * 60 * 1000);
  return date.toISOString().slice(0, 10);
}

function todayYmd(timezone = 'America/New_York') {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

function ensureArray(value) {
  return Array.isArray(value) ? value : [];
}

function unique(values) {
  const out = [];
  const seen = new Set();
  for (const value of values || []) {
    const trimmed = String(value || '').trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}

function extractWikilinks(markdown) {
  const links = [];
  const re = /\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]/g;
  let match;
  while ((match = re.exec(String(markdown || ''))) !== null) {
    if (match[1]) links.push(match[1].trim());
  }
  return unique(links);
}

function splitFrontmatter(markdown) {
  const text = String(markdown || '');
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) return { frontmatter: {}, body: text };
  const frontmatter = {};
  for (const line of match[1].split(/\r?\n/)) {
    const parts = line.match(/^([^:#][^:]*):\s*(.*)$/);
    if (!parts) continue;
    frontmatter[parts[1].trim()] = parts[2].trim();
  }
  return { frontmatter, body: text.slice(match[0].length) };
}

function parseList(value) {
  if (Array.isArray(value)) return value.map(String).map((item) => item.trim()).filter(Boolean);
  const raw = String(value || '').trim();
  if (!raw) return [];
  if (raw.startsWith('[')) {
    try {
      const parsed = JSON.parse(raw.replace(/'/g, '"'));
      if (Array.isArray(parsed)) return parsed.map(String).map((item) => item.trim()).filter(Boolean);
    } catch {
      // Fall through to comma parsing.
    }
  }
  return raw.split(',').map((item) => item.replace(/^[-\s]+/, '').trim()).filter(Boolean);
}

function extractConcepts(title, markdown, artifact = null) {
  const artifactConcepts = unique([
    ...ensureArray(artifact?.concepts),
    ...ensureArray(artifact?.derivative?.concepts),
    ...ensureArray(artifact?.entities),
    ...ensureArray(artifact?.derivative?.entities),
  ]);
  if (artifactConcepts.length) return artifactConcepts.map(slugify).slice(0, 32);

  const { frontmatter, body } = splitFrontmatter(markdown);
  const wikilinks = extractWikilinks(body).map(slugify);
  const tags = parseList(frontmatter.tags || frontmatter.tag).map(slugify);
  const entities = [];
  const re = /\b([A-Z][A-Za-z0-9]+(?:\s+[A-Z][A-Za-z0-9]+){0,3})\b/g;
  let match;
  while ((match = re.exec(`${title}\n${body}`)) !== null && entities.length < 18) {
    const candidate = match[1].trim();
    if (!/^(The|This|That|Notes|Journal|Today|Summary)$/.test(candidate)) entities.push(slugify(candidate));
  }
  return unique([...wikilinks, ...tags, ...entities]).slice(0, 32);
}

function summarizeMarkdown(markdown, artifact = null) {
  const artifactSummary = String(artifact?.summary || artifact?.derivative?.summary || '').trim();
  if (artifactSummary) return artifactSummary.slice(0, 360);
  const { body } = splitFrontmatter(markdown);
  const clean = body
    .replace(/^#\s+.+$/gm, '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_m, target, alias) => alias || target)
    .replace(/\s+/g, ' ')
    .trim();
  return clean.split(/\s+/).slice(0, 42).join(' ');
}

function artifactRelationshipTargets(artifact) {
  return unique([
    ...ensureArray(artifact?.relationships).map((edge) => edge?.target).filter(Boolean),
    ...ensureArray(artifact?.derivative?.relationships?.wikilinks),
  ]);
}

function safeRead(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

function safeReadJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function walkMarkdown(dir) {
  const files = [];
  function walk(current) {
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const filePath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === '.git' || entry.name === 'node_modules' || entry.name.startsWith('.jarvos')) continue;
        walk(filePath);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
        files.push(filePath);
      }
    }
  }
  walk(dir);
  return files;
}

function loadKnowledgeArtifacts(knowledgeDir) {
  const byTitle = new Map();
  const bySource = new Map();
  const artifactsDir = path.join(knowledgeDir || '', 'artifacts');
  let entries;
  try {
    entries = fs.readdirSync(artifactsDir, { withFileTypes: true });
  } catch {
    return { byTitle, bySource };
  }

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const artifactPath = path.join(artifactsDir, entry.name);
    const artifact = safeReadJson(artifactPath);
    if (!artifact || typeof artifact !== 'object') continue;
    artifact.artifactPath = artifactPath;
    if (artifact.title) byTitle.set(normalizeTitle(artifact.title), artifact);
    if (artifact.sourceNote) bySource.set(String(artifact.sourceNote).replace(/\\/g, '/'), artifact);
  }
  return { byTitle, bySource };
}

function sourcePathFor(filePath, notesDir) {
  const rel = path.relative(path.dirname(notesDir), filePath).replace(/\\/g, '/');
  return rel && !rel.startsWith('..') ? rel : path.basename(filePath);
}

function loadNotes(notesDir, knowledgeDir) {
  const artifacts = loadKnowledgeArtifacts(knowledgeDir);
  const byTitle = new Map();
  for (const filePath of walkMarkdown(notesDir)) {
    const title = path.basename(filePath, '.md');
    const sourcePath = sourcePathFor(filePath, notesDir);
    const body = safeRead(filePath) || '';
    const artifact = artifacts.byTitle.get(normalizeTitle(title)) || artifacts.bySource.get(sourcePath);
    const wikilinks = unique([...extractWikilinks(body), ...artifactRelationshipTargets(artifact)]);
    byTitle.set(normalizeTitle(title), {
      title,
      filePath,
      sourcePath,
      summary: summarizeMarkdown(body, artifact),
      concepts: extractConcepts(title, body, artifact),
      wikilinks,
      artifactPath: artifact?.artifactPath || null,
    });
  }

  for (const artifact of artifacts.byTitle.values()) {
    const key = normalizeTitle(artifact.title);
    if (byTitle.has(key)) continue;
    byTitle.set(key, {
      title: artifact.title,
      filePath: null,
      sourcePath: artifact.sourceNote || null,
      summary: summarizeMarkdown('', artifact),
      concepts: extractConcepts(artifact.title, '', artifact),
      wikilinks: artifactRelationshipTargets(artifact),
      artifactPath: artifact.artifactPath || null,
    });
  }

  return byTitle;
}

function listRecentJournalEntries(journalDir, { date = todayYmd(), days = DEFAULT_WINDOW_DAYS } = {}) {
  const end = ymdToTime(date);
  if (end === null) throw new Error(`Invalid date: ${date}`);
  const start = ymdToTime(dateFromOffset(date, -(Number(days) || DEFAULT_WINDOW_DAYS) + 1));
  let entries;
  try {
    entries = fs.readdirSync(journalDir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isFile() && /^\d{4}-\d{2}-\d{2}\.md$/.test(entry.name))
    .map((entry) => {
      const entryDate = entry.name.replace(/\.md$/i, '');
      return { date: entryDate, filePath: path.join(journalDir, entry.name), time: ymdToTime(entryDate) };
    })
    .filter((entry) => entry.time !== null && entry.time >= start && entry.time <= end)
    .sort((a, b) => b.date.localeCompare(a.date))
    .map(({ time: _time, ...entry }) => entry);
}

function extractJournalRefs(entry) {
  const body = safeRead(entry.filePath) || '';
  const links = extractWikilinks(body);
  return {
    ...entry,
    links,
    body,
  };
}

function upsertCandidate(candidates, note, source) {
  const key = normalizeTitle(note.title);
  const existing = candidates.get(key) || {
    title: note.title,
    sourcePath: note.sourcePath,
    filePath: note.filePath,
    summary: note.summary,
    concepts: note.concepts,
    wikilinks: note.wikilinks,
    artifactPath: note.artifactPath,
    directJournalRefs: [],
    relatedFrom: [],
    retrievalRefs: [],
  };
  if (source.kind === 'journal') existing.directJournalRefs.push(source);
  if (source.kind === 'related') existing.relatedFrom.push(source);
  if (source.kind === 'retrieval') existing.retrievalRefs.push(source);
  candidates.set(key, existing);
  return existing;
}

function collectCandidates({ journalEntries, notesByTitle, retrievalSeeds = [] }) {
  const candidates = new Map();

  for (const entry of journalEntries) {
    for (const title of entry.links) {
      const note = notesByTitle.get(normalizeTitle(title));
      if (!note) continue;
      upsertCandidate(candidates, note, { kind: 'journal', date: entry.date, journalPath: entry.filePath });
    }
  }

  const direct = [...candidates.values()];
  for (const candidate of direct) {
    for (const relatedTitle of candidate.wikilinks || []) {
      const note = notesByTitle.get(normalizeTitle(relatedTitle));
      if (!note) continue;
      upsertCandidate(candidates, note, { kind: 'related', from: candidate.title, relationship: 'wikilink' });
    }
  }

  for (const seed of retrievalSeeds || []) {
    const title = typeof seed === 'string' ? seed : seed.title;
    const note = notesByTitle.get(normalizeTitle(title));
    if (!note) continue;
    upsertCandidate(candidates, note, {
      kind: 'retrieval',
      query: seed.query || null,
      mode: seed.mode || null,
      rank: seed.rank || null,
    });
  }

  return candidates;
}

function buildConceptIndex(candidates) {
  const index = new Map();
  for (const candidate of candidates) {
    for (const concept of candidate.concepts || []) {
      if (!index.has(concept)) index.set(concept, []);
      index.get(concept).push(candidate.title);
    }
  }
  return index;
}

function scoreCandidates(candidates) {
  const conceptIndex = buildConceptIndex(candidates);
  return candidates.map((candidate) => {
    const sharedConcepts = (candidate.concepts || []).filter((concept) => (conceptIndex.get(concept) || []).length > 1);
    const score = (candidate.directJournalRefs.length * 5)
      + (candidate.relatedFrom.length * 2)
      + (candidate.retrievalRefs.length * 3)
      + Math.min(sharedConcepts.length, 8);
    return {
      ...candidate,
      sharedConcepts,
      score,
      evidence: {
        journalDates: unique(candidate.directJournalRefs.map((ref) => ref.date)),
        relatedFrom: unique(candidate.relatedFrom.map((ref) => ref.from)),
        retrievalQueries: unique(candidate.retrievalRefs.map((ref) => ref.query).filter(Boolean)),
      },
    };
  }).sort((a, b) => b.score - a.score || a.title.localeCompare(b.title));
}

function buildClusters(scoredCandidates, limit = DEFAULT_LIMIT) {
  const selected = scoredCandidates.slice(0, limit);
  const conceptIndex = buildConceptIndex(selected);
  const clusters = [];
  const usedTitles = new Set();

  const concepts = [...conceptIndex.entries()]
    .filter(([, titles]) => titles.length > 1)
    .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
    .slice(0, 6);

  for (const [concept, titles] of concepts) {
    const candidateTitles = titles
      .filter((title) => !usedTitles.has(title))
      .slice(0, 5);
    if (candidateTitles.length < 2) continue;
    candidateTitles.forEach((title) => usedTitles.add(title));
    clusters.push(clusterFor(concept, candidateTitles, selected));
  }

  const remainingDirect = selected
    .filter((candidate) => candidate.directJournalRefs.length && !usedTitles.has(candidate.title))
    .slice(0, 5)
    .map((candidate) => candidate.title);
  if (remainingDirect.length) clusters.push(clusterFor('journal-spine', remainingDirect, selected));

  return clusters;
}

function labelForConcept(concept) {
  return String(concept || 'journal-spine')
    .split('-')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function clusterFor(concept, candidateTitles, candidates) {
  const byTitle = new Map(candidates.map((candidate) => [candidate.title, candidate]));
  const evidence = candidateTitles
    .map((title) => byTitle.get(title))
    .filter(Boolean)
    .map((candidate) => ({
      title: candidate.title,
      score: candidate.score,
      journalDates: candidate.evidence.journalDates,
      relatedFrom: candidate.evidence.relatedFrom,
    }));
  const label = labelForConcept(concept);
  return {
    id: slugify(`${concept}-${candidateTitles.join('-')}`).slice(0, 80),
    label,
    concepts: concept === 'journal-spine' ? [] : [concept],
    candidateTitles,
    evidence,
    suggestions: [
      {
        type: 'explore',
        prompt: `Explore how ${candidateTitles.map((title) => `[[${title}]]`).join(', ')} connect around ${label}.`,
        candidateTitles,
      },
      {
        type: 'expand',
        prompt: `Expand the strongest reusable note from this ${label} cluster with missing context and backlinks.`,
        candidateTitles,
      },
    ],
  };
}

function buildMcpSurface(report) {
  return {
    toolName: 'journal_spine_synthesis',
    description: 'Traverse recent journal links into the note graph and return tight synthesis candidates.',
    inputSchema: {
      type: 'object',
      properties: {
        date: { type: 'string', description: 'YYYY-MM-DD end date for the journal window.' },
        days: { type: 'integer', description: 'Number of recent journal days to inspect.' },
        limit: { type: 'integer', description: 'Maximum candidates to return.' },
      },
    },
    result: {
      content: [
        { type: 'text', text: renderMarkdown(report) },
        { type: 'json', json: report },
      ],
    },
  };
}

function renderMarkdown(report) {
  const lines = [
    `# Journal Spine Synthesis — ${report.date}`,
    '',
    `Window: ${report.window.startDate} to ${report.window.endDate}`,
    `Journal entries: ${report.journalEntries.length}`,
    `Candidates: ${report.candidates.length}`,
    '',
    '## Clusters',
  ];
  if (!report.clusters.length) lines.push('- No synthesis clusters found.');
  for (const cluster of report.clusters) {
    lines.push(`- ${cluster.label}: ${cluster.candidateTitles.map((title) => `[[${title}]]`).join(', ')}`);
    for (const suggestion of cluster.suggestions.slice(0, 1)) {
      lines.push(`  - ${suggestion.type}: ${suggestion.prompt}`);
    }
  }
  lines.push('', '## Top Candidates');
  for (const candidate of report.candidates.slice(0, report.limit)) {
    const refs = candidate.evidence.journalDates.length ? `journal ${candidate.evidence.journalDates.join(', ')}` : 'related note graph';
    lines.push(`- [[${candidate.title}]] (${candidate.score}) — ${refs}${candidate.summary ? ` — ${candidate.summary}` : ''}`);
  }
  return `${lines.join('\n').trim()}\n`;
}

function defaultKnowledgeDir(notesDir) {
  const vaultRoot = path.basename(notesDir || '').toLowerCase() === 'notes' ? path.dirname(notesDir) : notesDir;
  return process.env.JARVOS_KNOWLEDGE_DIR || path.join(vaultRoot, '.jarvos', 'knowledge');
}

function buildJournalSpineSynthesis(options = {}) {
  const config = options.config || resolveConfig(options.resolveOptions || {});
  const date = options.date || todayYmd(config.user?.timezone);
  const days = Number(options.days || DEFAULT_WINDOW_DAYS);
  const limit = Number(options.limit || DEFAULT_LIMIT);
  const notesDir = options.notesDir || config.paths.notes;
  const journalDir = options.journalDir || config.paths.journal;
  const knowledgeDir = options.knowledgeDir || defaultKnowledgeDir(notesDir);
  const startDate = dateFromOffset(date, -days + 1);

  const journalEntries = listRecentJournalEntries(journalDir, { date, days }).map(extractJournalRefs);
  const notesByTitle = loadNotes(notesDir, knowledgeDir);
  const candidates = scoreCandidates([
    ...collectCandidates({
      journalEntries,
      notesByTitle,
      retrievalSeeds: options.retrievalSeeds || [],
    }).values(),
  ]);
  const clusters = buildClusters(candidates, limit);
  const report = {
    version: VERSION,
    kind: 'journal-spine-synthesis',
    date,
    generatedAt: options.generatedAt || new Date().toISOString(),
    window: { startDate, endDate: date, days },
    paths: { notesDir, journalDir, knowledgeDir },
    limit,
    journalEntries: journalEntries.map((entry) => ({
      date: entry.date,
      path: entry.filePath,
      links: entry.links,
    })),
    candidates: candidates.slice(0, limit).map((candidate) => ({
      title: candidate.title,
      score: candidate.score,
      sourcePath: candidate.sourcePath,
      summary: candidate.summary,
      concepts: candidate.concepts,
      sharedConcepts: candidate.sharedConcepts,
      evidence: candidate.evidence,
      artifactPath: candidate.artifactPath,
    })),
    clusters,
    llmPrompt: buildLlmPrompt({ date, clusters, candidates: candidates.slice(0, limit) }),
  };
  return report;
}

function buildLlmPrompt({ date, clusters, candidates }) {
  const clusterLines = clusters.map((cluster) => `- ${cluster.label}: ${cluster.candidateTitles.join(', ')}`);
  const candidateLines = candidates.slice(0, DEFAULT_LIMIT).map((candidate) => {
    const refs = candidate.evidence.journalDates.length ? candidate.evidence.journalDates.join(', ') : 'note-graph';
    return `- ${candidate.title} [score ${candidate.score}; ${refs}]: ${candidate.summary || 'No summary.'}`;
  });
  return [
    `You are synthesizing the journal spine for ${date}.`,
    'Use only the candidate notes below. Propose explore/expand suggestions that would improve the knowledge base.',
    '',
    'Clusters:',
    ...clusterLines,
    '',
    'Candidate notes:',
    ...candidateLines,
  ].join('\n').trim();
}

function writeSynthesisReport(report, outputDir = path.join(report.paths.knowledgeDir, 'synthesis')) {
  fs.mkdirSync(outputDir, { recursive: true, mode: 0o700 });
  const jsonPath = path.join(outputDir, `${report.date}.json`);
  const mdPath = path.join(outputDir, `${report.date}.md`);
  fs.writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  fs.writeFileSync(mdPath, renderMarkdown(report), { mode: 0o600 });
  return { jsonPath, mdPath };
}

module.exports = {
  DEFAULT_LIMIT,
  DEFAULT_WINDOW_DAYS,
  VERSION,
  buildJournalSpineSynthesis,
  buildMcpSurface,
  buildLlmPrompt,
  dateFromOffset,
  extractWikilinks,
  listRecentJournalEntries,
  loadKnowledgeArtifacts,
  loadNotes,
  normalizeTitle,
  renderMarkdown,
  scoreCandidates,
  slugify,
  writeSynthesisReport,
};
