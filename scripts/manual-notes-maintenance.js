#!/usr/bin/env node
'use strict';

const { main } = require('../modules/jarvos-secondbrain/packages/jarvos-secondbrain-notes/src/manual-notes-maintenance');
const { createObsidianOwnedMutationService } = require('../modules/jarvos-secondbrain/bridge/provenance/src/obsidian-mutation');

let mutationService;
main({
  // Construct the transport only if --apply actually reaches a Markdown
  // mutation. Dry-run is intentionally a read-only local audit.
  applyMarkdownMutation: (mutation) => {
    mutationService ||= createObsidianOwnedMutationService({ source: 'scripts.manual-notes-maintenance' });
    return mutationService.applyMarkdownMutation(mutation);
  },
});
