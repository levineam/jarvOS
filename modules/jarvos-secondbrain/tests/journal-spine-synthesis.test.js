const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  buildJournalSpineSynthesis,
  buildMcpSurface,
  extractWikilinks,
  renderMarkdown,
  writeSynthesisReport,
} = require('../bridge/synthesis');

function makeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'journal-spine-synthesis-'));
  const notesDir = path.join(root, 'Notes');
  const journalDir = path.join(root, 'Journal');
  const knowledgeDir = path.join(root, '.jarvos', 'knowledge');
  fs.mkdirSync(notesDir, { recursive: true });
  fs.mkdirSync(journalDir, { recursive: true });
  fs.mkdirSync(path.join(knowledgeDir, 'artifacts'), { recursive: true });

  fs.writeFileSync(path.join(journalDir, '2026-05-18.md'), [
    '# Journal 2026-05-18',
    '',
    '## Notes',
    '- Revisited [[Knowledge Base Note Naming]] and [[Good Notes are Modular]].',
  ].join('\n'));
  fs.writeFileSync(path.join(journalDir, '2026-05-19.md'), [
    '# Journal 2026-05-19',
    '',
    '## Notes',
    '- [[Journal Spine Traversal]] should connect to [[Knowledge Base Note Naming]].',
  ].join('\n'));
  fs.writeFileSync(path.join(journalDir, '2026-05-12.md'), '- [[Old Note]]\n');

  fs.writeFileSync(path.join(notesDir, 'Knowledge Base Note Naming.md'), [
    '---',
    'tags: [knowledge, retrieval]',
    '---',
    '# Knowledge Base Note Naming',
    '',
    'Concept-first titles improve [[Journal Spine Traversal]] and retrieval.',
  ].join('\n'));
  fs.writeFileSync(path.join(notesDir, 'Good Notes are Modular.md'), [
    '# Good Notes are Modular',
    '',
    'Small reusable notes support [[Knowledge Base Note Naming]].',
  ].join('\n'));
  fs.writeFileSync(path.join(notesDir, 'Journal Spine Traversal.md'), [
    '# Journal Spine Traversal',
    '',
    'Walk the daily journal into durable notes and [[Morning Synthesis]].',
  ].join('\n'));
  fs.writeFileSync(path.join(notesDir, 'Morning Synthesis.md'), [
    '# Morning Synthesis',
    '',
    'A morning job proposes explore and expand actions from recent journal context.',
  ].join('\n'));

  fs.writeFileSync(path.join(knowledgeDir, 'artifacts', 'journal-spine.json'), JSON.stringify({
    title: 'Journal Spine Traversal',
    sourceNote: 'Notes/Journal Spine Traversal.md',
    summary: 'Traversal starts from recent journal entries and follows note graph edges.',
    concepts: ['journal-spine', 'retrieval', 'knowledge'],
    relationships: [{ type: 'wikilink', target: 'Morning Synthesis', targetSlug: 'morning-synthesis' }],
  }, null, 2));
  fs.writeFileSync(path.join(knowledgeDir, 'artifacts', 'naming.json'), JSON.stringify({
    title: 'Knowledge Base Note Naming',
    sourceNote: 'Notes/Knowledge Base Note Naming.md',
    summary: 'Concept-first titles make local search and synthesis easier.',
    concepts: ['knowledge', 'retrieval', 'note-naming'],
    relationships: [{ type: 'wikilink', target: 'Journal Spine Traversal', targetSlug: 'journal-spine-traversal' }],
  }, null, 2));

  return { root, notesDir, journalDir, knowledgeDir };
}

test('extractWikilinks handles aliases, headings, and duplicates', () => {
  assert.deepEqual(
    extractWikilinks('[[Alpha]] [[Beta|label]] [[Gamma#Part]] [[Alpha]]'),
    ['Alpha', 'Beta', 'Gamma'],
  );
});

test('buildJournalSpineSynthesis traverses recent journals into note graph clusters', () => {
  const fixture = makeFixture();
  const report = buildJournalSpineSynthesis({
    date: '2026-05-19',
    days: 2,
    limit: 10,
    notesDir: fixture.notesDir,
    journalDir: fixture.journalDir,
    knowledgeDir: fixture.knowledgeDir,
    generatedAt: '2026-05-20T00:00:00.000Z',
  });

  assert.equal(report.kind, 'journal-spine-synthesis');
  assert.equal(report.journalEntries.length, 2);
  assert.ok(report.journalEntries.every((entry) => entry.date !== '2026-05-12'));
  assert.ok(report.candidates.some((candidate) => candidate.title === 'Knowledge Base Note Naming'));
  assert.ok(report.candidates.some((candidate) => candidate.title === 'Morning Synthesis'));
  assert.ok(report.clusters.some((cluster) => cluster.candidateTitles.includes('Journal Spine Traversal')));
  assert.match(report.llmPrompt, /Use only the candidate notes below/);
});

test('MCP surface and write outputs expose markdown and JSON result shapes', () => {
  const fixture = makeFixture();
  const report = buildJournalSpineSynthesis({
    date: '2026-05-19',
    days: 2,
    notesDir: fixture.notesDir,
    journalDir: fixture.journalDir,
    knowledgeDir: fixture.knowledgeDir,
  });
  const surface = buildMcpSurface(report);
  assert.equal(surface.toolName, 'journal_spine_synthesis');
  assert.equal(surface.result.content[0].type, 'text');
  assert.equal(surface.result.content[1].type, 'json');
  assert.match(renderMarkdown(report), /Journal Spine Synthesis/);

  const written = writeSynthesisReport(report, path.join(fixture.root, 'out'));
  assert.ok(fs.existsSync(written.jsonPath));
  assert.ok(fs.existsSync(written.mdPath));
  assert.equal(JSON.parse(fs.readFileSync(written.jsonPath, 'utf8')).kind, 'journal-spine-synthesis');
});
