#!/usr/bin/env node
'use strict';

// Public transports are deliberately thin.  Installed hosts supply the
// authenticated application-service instance; this adapter never persists
// requests, resolves credentials, or advances command lifecycle state itself.
const path = require('path');

const OPERATION_ALIASES = Object.freeze({ request: 'createRequest' });
const PUBLIC_OPERATIONS = new Set(['list', 'inspect', 'evidence', 'approval-state', 'createRequest', 'approve']);

function normalizeOperation(operation) {
  const normalized = OPERATION_ALIASES[operation] || operation;
  if (!PUBLIC_OPERATIONS.has(normalized)) throw new Error(`unsupported public control-plane operation: ${operation}`);
  return normalized;
}

function loadHostService(modulePath) {
  if (!modulePath) throw new Error('control-plane host service is not configured');
  const resolved = path.resolve(modulePath);
  // This module path is an installed-host configuration boundary. It must
  // export either the service itself or a zero-argument factory for it.
  const configured = require(resolved);
  const service = typeof configured === 'function'
    ? configured()
    : typeof configured.createApplicationService === 'function'
      ? configured.createApplicationService()
      : configured.applicationService || configured;
  if (!service || typeof service.execute !== 'function') throw new Error('configured control-plane host service must expose execute');
  return service;
}

function createControlPlaneService(options = {}) {
  const applicationService = options.applicationService || loadHostService(
    options.serviceModule || process.env.JARVOS_CONTROL_PLANE_SERVICE_MODULE,
  );
  if (typeof applicationService.execute !== 'function') throw new Error('applicationService must expose execute');

  return {
    execute(operation, input = {}) {
      const { service: _service, applicationService: _applicationService, serviceModule: _serviceModule, ...request } = input;
      return applicationService.execute(normalizeOperation(operation), request);
    },
  };
}

function parseCli(argv) {
  const [operation = 'help', ...rest] = argv;
  const input = {};
  for (let index = 0; index < rest.length; index += 1) {
    const key = rest[index];
    if (!key.startsWith('--')) continue;
    const name = key.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    input[name] = rest[index + 1] && !rest[index + 1].startsWith('--') ? rest[++index] : true;
  }
  if (input.input) Object.assign(input, JSON.parse(input.input));
  return { operation, input };
}

function usage() {
  return 'Usage: jarvos-manager <list|inspect|evidence|approval-state|request|approve> --credential <credential> [--request-id <id>] [--input <json>]';
}

function main() {
  const { operation, input } = parseCli(process.argv.slice(2));
  if (operation === 'help' || input.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const result = createControlPlaneService().execute(operation, input);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (require.main === module) {
  try { main(); } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}

module.exports = { PUBLIC_OPERATIONS, createControlPlaneService, normalizeOperation, parseCli };
