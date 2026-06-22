'use strict';

const fs = require('node:fs');
const path = require('node:path');

function readMarkdownFiles(rootDir) {
  const docs = [];
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
        walk(filePath);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
        docs.push({
          path: filePath,
          relativePath: path.relative(rootDir, filePath).replace(/\\/g, '/'),
          text: fs.readFileSync(filePath, 'utf8'),
        });
      }
    }
  }
  walk(rootDir);
  return docs.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

function tokenize(value) {
  return String(value || '')
    .toLowerCase()
    .match(/[a-z0-9]+/g) || [];
}

function scoreDoc(question, doc) {
  const terms = new Set(tokenize(question).filter((term) => term.length > 2));
  const haystack = tokenize(`${doc.relativePath}\n${doc.text}`);
  let score = 0;
  for (const term of haystack) {
    if (terms.has(term)) score += 1;
  }
  return score;
}

function searchDocs(question, docs, limit = 5) {
  return docs
    .map((doc) => ({ ...doc, score: scoreDoc(question, doc) }))
    .filter((doc) => doc.score > 0)
    .sort((a, b) => b.score - a.score || a.relativePath.localeCompare(b.relativePath))
    .slice(0, limit);
}

function buildGraphDocs(docs) {
  return docs.map((doc) => {
    const links = [...doc.text.matchAll(/\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]/g)]
      .map((match) => match[1])
      .join(' ');
    const headings = [...doc.text.matchAll(/^#+\s+(.+)$/gm)].map((match) => match[1]).join(' ');
    return {
      ...doc,
      text: `${doc.text}\n\nGraph terms: ${links} ${headings}`,
    };
  });
}

function createQmdRetrievalAdapter({ roots = [] } = {}) {
  return {
    name: 'qmd-only',
    search(question) {
      const docs = roots.flatMap(readMarkdownFiles);
      return searchDocs(question, docs);
    },
  };
}

function createWikiRetrievalAdapter({ roots = [] } = {}) {
  return {
    name: 'qmd-plus-llm-wiki',
    search(question) {
      const docs = roots.flatMap(readMarkdownFiles);
      return searchDocs(question, docs);
    },
  };
}

function createGraphRetrievalAdapter({ roots = [], enabled = false } = {}) {
  return {
    name: 'qmd-plus-graph',
    enabled,
    search(question) {
      if (!enabled) {
        return [];
      }
      const docs = roots.flatMap(readMarkdownFiles);
      return searchDocs(question, buildGraphDocs(docs));
    },
  };
}

function resultHasEvidence(result, expectedEvidence) {
  const needle = String(expectedEvidence || '').toLowerCase();
  return result.some((doc) => `${doc.relativePath}\n${doc.text}`.toLowerCase().includes(needle));
}

function runRetrievalEvalPack({ questions, adapters }) {
  return {
    version: 1,
    evaluatedAt: new Date().toISOString(),
    results: questions.map((question) => {
      const adapterResults = adapters.map((adapter) => {
        const hits = adapter.search(question.question);
        return {
          adapter: adapter.name,
          enabled: adapter.enabled !== false,
          passed: resultHasEvidence(hits, question.expectedEvidence),
          expectedEvidence: question.expectedEvidence,
          hits: hits.map((hit) => ({
            path: hit.relativePath,
            score: hit.score,
          })),
        };
      });
      return {
        id: question.id,
        category: question.category,
        question: question.question,
        adapters: adapterResults,
      };
    }),
  };
}

function summarizeRetrievalEval(report) {
  const adapters = new Map();
  for (const result of report.results) {
    for (const adapter of result.adapters) {
      const current = adapters.get(adapter.adapter) || { passed: 0, total: 0 };
      current.total += 1;
      if (adapter.passed) current.passed += 1;
      adapters.set(adapter.adapter, current);
    }
  }
  return [...adapters.entries()].map(([adapter, counts]) => ({
    adapter,
    ...counts,
    ok: counts.passed === counts.total,
  }));
}

module.exports = {
  createGraphRetrievalAdapter,
  createQmdRetrievalAdapter,
  createWikiRetrievalAdapter,
  runRetrievalEvalPack,
  summarizeRetrievalEval,
};
