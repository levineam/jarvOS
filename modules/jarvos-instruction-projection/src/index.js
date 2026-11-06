'use strict';

const contracts = require('./contracts');
const catalog = require('./catalog');
const render = require('./render');
const receipts = require('./receipts');
const projection = require('./projection');

module.exports = {
  ...require('./managed-block'),
  ...require('./capture-guideline'),
  ...contracts,
  ...catalog,
  ...render,
  ...receipts,
  ...projection,
};
