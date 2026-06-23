'use strict';

const {
  createSessionSourceAdapter,
} = require('../session-source/session-source-adapter');

function createHermesSessionAdapter(options = {}) {
  return createSessionSourceAdapter('hermes', options);
}

module.exports = {
  createHermesSessionAdapter,
};
