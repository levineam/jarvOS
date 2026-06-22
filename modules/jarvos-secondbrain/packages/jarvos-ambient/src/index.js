'use strict';

const intent = require('./intent');
const adapters = require('./adapters');
const routing = require('./routing');

module.exports = {
  adapters,
  intent,
  routing,
  ...adapters,
  ...intent,
  ...routing,
};
