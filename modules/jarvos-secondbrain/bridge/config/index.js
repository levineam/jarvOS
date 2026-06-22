#!/usr/bin/env node
'use strict';

const config = require('./src/resolve-config');
const paperclip = require('./src/paperclip');
const sharedVaultOnboarding = require('./src/shared-vault-onboarding');

module.exports = {
  ...config,
  ...paperclip,
  ...sharedVaultOnboarding,
};
