'use strict';

const {
  createSessionSourceAdapter,
} = require('../session-source/session-source-adapter');

function createClaudeCodeSessionAdapter(options = {}) {
  return createSessionSourceAdapter('claude-code', options);
}

module.exports = {
  createClaudeCodeSessionAdapter,
};
