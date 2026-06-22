#!/usr/bin/env node
// Package-local compatibility shim for the bridge-owned note/journal contract.

'use strict';

const { main } = require('../bridge/provenance/src/note-journal-contract.js');

main();
