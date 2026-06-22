'use strict';

const {
  createSessionSourceAdapter,
} = require('../session-source/session-source-adapter');

function createOpenClawSessionAdapter(options = {}) {
  return createSessionSourceAdapter('openclaw', options);
}

module.exports = {
  createOpenClawSessionAdapter,
};
