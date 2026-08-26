'use strict';

const contracts = require('./contracts');
const catalog = require('./catalog');
const render = require('./render');
const receipts = require('./receipts');
const projection = require('./projection');

module.exports = {
  ...contracts,
  ...catalog,
  ...render,
  ...receipts,
  ...projection,
};
