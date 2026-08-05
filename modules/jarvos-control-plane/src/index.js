'use strict';

const contracts = require('./contracts');
const registry = require('./registry');
const reconciliation = require('./reconciliation');
const policy = require('./policy');
const storage = require('./storage');
const applicationService = require('./application-service');
const protectedResource = require('./protected-resource');

module.exports = {
  ...contracts,
  ...registry,
  ...reconciliation,
  ...policy,
  ...storage,
  ...applicationService,
  ...protectedResource,
};
