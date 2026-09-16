'use strict';

// Machine-checkable inventory of the supported canonical durable writers.
//
// The invariant this module protects is narrow and load-bearing: a durable note
// must persist explicit `jarvos-content-origin/v1` frontmatter, and a material
// journal bullet must be written with the adjacent hidden, digest-bound marker.
// An unmarked material bullet is not neutral — `parseJournalEntry` reads it as
// an unmarked manual entry, i.e. as Andrew's own words. So a newly added writer
// that never declares how it emits the contract has to fail the suite rather
// than quietly inherit human attribution.
//
// Enforcement has two halves:
//
//   1. Module inventory. Every source module that calls a durable write
//      primitive must appear in `CANONICAL_WRITERS` with a declaration mode.
//      A new caller (undeclared) and a removed caller (stale) both fail.
//   2. Transform inventory. Every registered vault transform must appear in
//      `JOURNAL_BULLET_TRANSFORMS`, and new material journal bullets must be
//      written through the marker-emitting transform.

const fs = require('node:fs');
const path = require('node:path');

const { CONTENT_ORIGIN_SCHEMA_VERSION } = require('./content-origin-contract');

const CONTENT_ORIGIN_WRITER_INVENTORY_VERSION = 'jarvos-content-origin-writers/v1';

// Resolved from this file so the check runs the same way from any cwd.
const SECONDBRAIN_ROOT = path.resolve(__dirname, '..', '..', '..');

const DECLARATION_MODES = Object.freeze([
  // Persists the five v1 frontmatter fields itself.
  'note_frontmatter',
  // Writes the adjacent hidden, digest-bound journal marker.
  'journal_marker',
  // Forwards a caller-supplied declaration to a canonical writer unchanged.
  'delegates',
  // Writes only note wikilink rows; the declaration lives in the linked note.
  'link_only',
  // Maintenance-only: never invents, upgrades, or drops a stored declaration.
  'preserves',
  // Creates durable records with no caller declaration; fails closed to unknown.
  'defaults_unknown',
  // Retained only to replay operations already recorded in the mutation ledger.
  'legacy_replay',
]);

// A module that calls one of these is a durable writer by construction.
const NOTE_WRITE_PRIMITIVES = Object.freeze(['writeNoteFile', 'createNoteMutationOperation']);
const JOURNAL_WRITE_PRIMITIVES = Object.freeze(['appendLineToJournalSection']);

const SCAN_ROOTS = Object.freeze(['adapters', 'bridge', 'packages', 'scripts', 'src']);
const SCAN_SKIP_DIRECTORIES = Object.freeze(new Set([
  'node_modules', 'tests', 'test', '__tests__', 'fixtures', 'migrations', 'docs', 'config',
]));

const CANONICAL_WRITERS = Object.freeze([
  {
    id: 'notes.write-to-vault',
    module: 'packages/jarvos-secondbrain-notes/src/write-to-vault.js',
    kind: 'note',
    declaration: 'note_frontmatter',
    note: 'Single canonical note write. Every durable note frontmatter passes through '
      + 'canonicalizeFrontmatter, which always emits the v1 fields; a material body '
      + 'change without a caller declaration drops the stored one instead of carrying it. '
      + 'Any write to an existing note whose normalized provenance differs from the '
      + 'stored provenance — including a note that stores none at all — is a whole-note '
      + 'replace, so an undeclared legacy note cannot keep taking prose through the '
      + 'append-only transforms and stay undeclared. '
      + 'preserveExistingBodyBytes is the one opt-in metadata-only repair: canonical '
      + 'frontmatter in front of an unchanged stored body, refused for anything else.',
  },
  {
    id: 'obsidian.vault-storage-adapter',
    module: 'adapters/obsidian/src/vault-storage-adapter.js',
    kind: 'note+journal',
    declaration: 'journal_marker',
    note: 'writeNote delegates to the canonical note writer. appendLineToJournalSection '
      + 'binds a supplied contentOrigin to the clean bullet digest and selects the '
      + 'marker-emitting journal-section-line@2 transform.',
  },
  {
    id: 'provenance.note-journal-contract',
    module: 'bridge/provenance/src/note-journal-contract.js',
    kind: 'note',
    declaration: 'delegates',
    note: 'Personality-facing contract. Normalizes the caller declaration through '
      + 'frontmatterForContentOrigin and defaults to unknown/unknown/ineligible.',
  },
  {
    id: 'provenance.notes-section-normalizer',
    module: 'bridge/provenance/src/notes-section-normalizer.js',
    kind: 'note',
    declaration: 'defaults_unknown',
    note: 'Promotes journal rows into notes without a caller declaration, so the '
      + 'canonical writer records unknown/unknown/ineligible rather than guessing.',
  },
  {
    id: 'routing.keyword-capture-router',
    module: 'bridge/routing/src/keyword-capture-router.js',
    kind: 'journal',
    declaration: 'delegates',
    note: 'Forwards the routing plan declaration to the adapter for every material '
      + 'journal bullet via journalContentOriginForPlan.',
  },
  {
    id: 'routing.three-package-router',
    module: 'bridge/routing/src/three-package-router.js',
    kind: 'journal',
    declaration: 'delegates',
    note: 'Same forwarding as the keyword router, against the configured heading.',
  },
  {
    id: 'ambient.local-storage-adapter',
    module: 'packages/jarvos-ambient/src/adapters/local-storage.js',
    kind: 'journal',
    declaration: 'delegates',
    note: 'Portable pass-through adapter; forwards the whole operation input, '
      + 'including contentOrigin, to the host storage adapter.',
  },
]);

const JOURNAL_BULLET_TRANSFORMS = Object.freeze([
  {
    name: 'append-line',
    version: 1,
    declaration: 'legacy_replay',
    writesMaterialBullet: true,
    note: 'Unstructured trailing bullet append. Not a supported path for new '
      + 'material journal content.',
  },
  {
    name: 'note-append-body',
    version: 1,
    declaration: 'preserves',
    writesMaterialBullet: false,
    note: 'Appends to a note body; the note frontmatter keeps its declaration. '
      + 'The canonical writer selects it only when the stored declaration already '
      + 'equals the normalized one, so it can never be the operation that leaves a '
      + 'note undeclared.',
  },
  {
    name: 'session-thread-append',
    version: 1,
    declaration: 'preserves',
    writesMaterialBullet: false,
    note: 'Appends a session thread entry to an existing declared note. Selected '
      + 'under the same condition as note-append-body: the declaration is already '
      + 'canonical and unchanged by this write.',
  },
  {
    name: 'journal-section-line',
    version: 1,
    declaration: 'legacy_replay',
    writesMaterialBullet: true,
    note: 'Pre-contract journal bullet without a marker. Retained only so already '
      + 'recorded ledger operations still replay deterministically.',
  },
  {
    name: 'journal-section-line',
    version: 2,
    declaration: 'journal_marker',
    writesMaterialBullet: true,
    note: 'The supported path for new material journal bullets. Requires a '
      + 'contentOrigin payload and writes the adjacent digest-bound marker.',
  },
  {
    name: 'journal-backlink',
    version: 1,
    declaration: 'link_only',
    writesMaterialBullet: false,
    note: 'Writes a bare note wikilink row; the declaration lives in the note.',
  },
]);

// The one transform new material journal content may use.
const SUPPORTED_MATERIAL_JOURNAL_TRANSFORM = Object.freeze({ name: 'journal-section-line', version: 2 });

function transformKey({ name, version }) {
  return `${name}@${version}`;
}

function isJsSource(fileName) {
  return fileName.endsWith('.js') && !fileName.endsWith('.test.js');
}

function walkSources(dir, out) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SCAN_SKIP_DIRECTORIES.has(entry.name)) continue;
      walkSources(absolute, out);
    } else if (entry.isFile() && isJsSource(entry.name)) {
      out.push(absolute);
    }
  }
  return out;
}

function callsPrimitive(source, primitives) {
  return primitives.some((primitive) => new RegExp(`\\b${primitive}\\s*\\(`).test(source));
}

/**
 * Discover every module that calls a durable note or journal write primitive.
 * Declaration-free discovery is the point: the inventory is compared against
 * what the tree actually does, not against what it says it does.
 */
function discoverCanonicalWriterModules({ root = SECONDBRAIN_ROOT } = {}) {
  const discovered = [];
  for (const scanRoot of SCAN_ROOTS) {
    for (const absolute of walkSources(path.join(root, scanRoot), [])) {
      const relative = path.relative(root, absolute).split(path.sep).join('/');
      // The contract and this inventory name the primitives to describe them.
      if (relative.startsWith('bridge/provenance/src/content-origin-')) continue;
      let source;
      try {
        source = fs.readFileSync(absolute, 'utf8');
      } catch {
        continue;
      }
      const note = callsPrimitive(source, NOTE_WRITE_PRIMITIVES);
      const journal = callsPrimitive(source, JOURNAL_WRITE_PRIMITIVES);
      if (!note && !journal) continue;
      discovered.push({
        module: relative,
        kind: note && journal ? 'note+journal' : note ? 'note' : 'journal',
      });
    }
  }
  return discovered.sort((left, right) => left.module.localeCompare(right.module));
}

/**
 * Compare the declared inventory against the tree. Returns a metadata-only
 * result: module paths and declaration modes, never vault content.
 */
function verifyWriterInventory({ root = SECONDBRAIN_ROOT } = {}) {
  const discovered = discoverCanonicalWriterModules({ root });
  const declaredByModule = new Map(CANONICAL_WRITERS.map((writer) => [writer.module, writer]));
  const discoveredByModule = new Map(discovered.map((entry) => [entry.module, entry]));

  const undeclared = discovered
    .filter((entry) => !declaredByModule.has(entry.module))
    .map((entry) => entry.module);
  const stale = CANONICAL_WRITERS
    .filter((writer) => !discoveredByModule.has(writer.module))
    .map((writer) => writer.module);
  const kindMismatch = CANONICAL_WRITERS
    .filter((writer) => {
      const found = discoveredByModule.get(writer.module);
      return found && found.kind !== writer.kind;
    })
    .map((writer) => ({ module: writer.module, declared: writer.kind, actual: discoveredByModule.get(writer.module).kind }));
  const invalidMode = CANONICAL_WRITERS
    .filter((writer) => !DECLARATION_MODES.includes(writer.declaration))
    .map((writer) => writer.module);

  return {
    inventory_version: CONTENT_ORIGIN_WRITER_INVENTORY_VERSION,
    content_origin_schema: CONTENT_ORIGIN_SCHEMA_VERSION,
    ok: !undeclared.length && !stale.length && !kindMismatch.length && !invalidMode.length,
    declared: CANONICAL_WRITERS.length,
    discovered: discovered.length,
    undeclared,
    stale,
    kindMismatch,
    invalidMode,
  };
}

/**
 * Compare the declared journal/note transform table against a live registry.
 * `registry.list()` is the enumerable set of registered transforms.
 */
function verifyJournalTransformInventory(registry) {
  const registered = typeof registry?.list === 'function' ? registry.list() : [];
  const declaredKeys = new Set(JOURNAL_BULLET_TRANSFORMS.map(transformKey));
  const registeredKeys = new Set(registered.map(transformKey));

  const undeclared = [...registeredKeys].filter((key) => !declaredKeys.has(key)).sort();
  const stale = [...declaredKeys].filter((key) => !registeredKeys.has(key)).sort();
  const supportedKey = transformKey(SUPPORTED_MATERIAL_JOURNAL_TRANSFORM);
  const supported = JOURNAL_BULLET_TRANSFORMS.find((entry) => transformKey(entry) === supportedKey);

  return {
    inventory_version: CONTENT_ORIGIN_WRITER_INVENTORY_VERSION,
    ok: !undeclared.length
      && !stale.length
      && registeredKeys.has(supportedKey)
      && supported?.declaration === 'journal_marker',
    undeclared,
    stale,
    supportedMaterialTransform: supportedKey,
  };
}

module.exports = {
  CONTENT_ORIGIN_WRITER_INVENTORY_VERSION,
  DECLARATION_MODES,
  NOTE_WRITE_PRIMITIVES,
  JOURNAL_WRITE_PRIMITIVES,
  SECONDBRAIN_ROOT,
  CANONICAL_WRITERS,
  JOURNAL_BULLET_TRANSFORMS,
  SUPPORTED_MATERIAL_JOURNAL_TRANSFORM,
  discoverCanonicalWriterModules,
  verifyWriterInventory,
  verifyJournalTransformInventory,
};
