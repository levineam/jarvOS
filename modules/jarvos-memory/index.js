'use strict';

const schema = require('./lib/memory-schema');
const config = require('./lib/memory-config');
const audit = require('./lib/audit-memory');
const memoryRecord = require('./lib/memory-record');

module.exports = {
  ...schema,
  ...config,
  ...audit,
  ...memoryRecord,
};
