'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { hashUtf8 } = require('../../adapters/obsidian/src/vault-mutation-contract');
const { createJarvosVaultTransforms } = require('../../src/vault-transform-registry');

// Test-only app.vault stand-in. Production callers must use the configured
// service and real Obsidian acknowledgement path.
function createAcknowledgedVaultMutationService(vaultRoot) {
  const transforms = createJarvosVaultTransforms();
  let sequence = 0;
  const service = {
    vaultId: 'vault:test-acknowledged',
    vaultRoot,
    createWriteContext({ vaultRelativePath, intentId, operationId, operationSource }) {
      sequence += 1;
      return {
        mutationExecutor: (operation) => service.execute(operation),
        operationId: operationId || intentId || `test-vault-operation-${String(sequence).padStart(4, '0')}`,
        sequence,
        source: operationSource || 'test.acknowledged-vault',
        vaultId: service.vaultId,
        vaultRoot,
        vaultRelativePath,
      };
    },
    execute(operation) {
      const target = path.join(vaultRoot, operation.vaultRelativePath);
      if (operation.operationKind === 'create') {
        if (fs.existsSync(target)) return fs.readFileSync(target, 'utf8') === operation.content ? { status: 'already_satisfied', obsidian: 'acknowledged' } : { status: 'conflict', obsidian: 'unacknowledged' };
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, operation.content, 'utf8');
      } else if (operation.operationKind === 'transform') {
        const current = fs.readFileSync(target, 'utf8');
        if (transforms.isSatisfied(current, operation)) return { status: 'already_satisfied', obsidian: 'acknowledged' };
        fs.writeFileSync(target, transforms.applyNode(current, operation), 'utf8');
      } else if (operation.operationKind === 'replace') {
        const current = fs.readFileSync(target, 'utf8');
        if (hashUtf8(current) !== operation.expectedHash) return { status: 'conflict', obsidian: 'unacknowledged' };
        fs.writeFileSync(target, operation.content, 'utf8');
      } else if (operation.operationKind === 'delete') {
        const current = fs.readFileSync(target, 'utf8');
        if (hashUtf8(current) !== operation.expectedHash) return { status: 'conflict', obsidian: 'unacknowledged' };
        fs.unlinkSync(target);
      } else throw new Error(`Unsupported test mutation kind: ${operation.operationKind}`);
      return { status: 'committed', obsidian: 'acknowledged' };
    },
  };
  return service;
}

module.exports = { createAcknowledgedVaultMutationService };
