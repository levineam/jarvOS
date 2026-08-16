#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { MAX_MESSAGE_CHARS, lintOperatorMessage, lintOperatorMessages } = require('../src/operator-notification-lint.js');

const DECLARATION_VERSION = 'jarvos-operator-notification-adapter/v1';
const DELIVERY_STATUS = 'not-configured';
const RUNTIME_IDS = ['claude', 'codex', 'hermes', 'openclaw'];
function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validateDeclaration(declaration, runtimeId) {
  const errors = [];
  if (!isObject(declaration)) return { ok: false, errors: ['operatorNotification declaration is required'] };
  const allowed = new Set(['version', 'contract', 'delivery']);
  for (const key of Object.keys(declaration)) if (!allowed.has(key)) errors.push(`operatorNotification has unknown field: ${key}`);
  if (declaration.version !== DECLARATION_VERSION) errors.push(`operatorNotification.version must be ${DECLARATION_VERSION}`);
  if (declaration.contract !== 'jarvos-operator-notification/v1') errors.push('operatorNotification.contract must be jarvos-operator-notification/v1');
  if (!isObject(declaration.delivery)) {
    errors.push('operatorNotification.delivery is required');
  } else {
    const allowedDelivery = new Set(['status', 'reason']);
    for (const key of Object.keys(declaration.delivery)) if (!allowedDelivery.has(key)) errors.push(`operatorNotification.delivery has unknown field: ${key}`);
    if (declaration.delivery.status !== DELIVERY_STATUS) errors.push(`operatorNotification.delivery.status must be ${DELIVERY_STATUS}`);
    if (typeof declaration.delivery.reason !== 'string' || declaration.delivery.reason.length < 20 || declaration.delivery.reason.length > 240) errors.push('operatorNotification.delivery.reason must be bounded explanatory text');
    if (/telegram|email|calendar|slack|discord|sms|push|webhook|https?:\/\//i.test(declaration.delivery.reason || '')) errors.push('operatorNotification.delivery.reason must not claim a transport');
  }
  if (!RUNTIME_IDS.includes(runtimeId)) errors.push(`runtime id is not an operator-notification adapter: ${runtimeId}`);
  return { ok: errors.length === 0, errors };
}

function lintAdapter(filePath) {
  let adapter;
  try {
    adapter = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    return { ok: false, file: filePath, errors: [`could not read adapter: ${error.message}`] };
  }
  const validation = validateDeclaration(adapter.operatorNotification, adapter.id);
  return { ok: validation.ok, file: filePath, id: adapter.id, errors: validation.errors };
}

function repositoryRoot(start = __dirname) {
  return path.resolve(start, '..', '..', '..');
}

function main(argv = process.argv.slice(2)) {
  const rootFlag = argv.find((arg) => arg.startsWith('--root='));
  const root = rootFlag ? path.resolve(rootFlag.slice('--root='.length)) : repositoryRoot();
  const results = RUNTIME_IDS.map((id) => lintAdapter(path.join(root, 'runtimes', id, 'adapter.json')));
  const result = { ok: results.every((item) => item.ok), results };
  if (argv.includes('--json')) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else for (const item of results) {
    process.stdout.write(`${item.ok ? 'PASS' : 'FAIL'} ${path.relative(root, item.file)}\n`);
    for (const error of item.errors) process.stdout.write(`  - ${error}\n`);
  }
  return result;
}

if (require.main === module) process.exitCode = main().ok ? 0 : 1;

module.exports = { DECLARATION_VERSION, DELIVERY_STATUS, MAX_MESSAGE_CHARS, RUNTIME_IDS, lintAdapter, lintOperatorMessage, lintOperatorMessages, main, validateDeclaration };
