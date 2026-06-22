'use strict';

const {
  createSessionSourceAdapter,
} = require('../session-source/session-source-adapter');

function createCodexSessionAdapter(options = {}) {
  return createSessionSourceAdapter('codex', options);
}

module.exports = {
  createCodexSessionAdapter,
};
