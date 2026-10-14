'use strict';

const { normalizeVaultRelativeMarkdownPath } = require('./artifact-receipt');

const OBSIDIAN_RESOLVER_ORIGIN = 'https://obsid.net/';

function assertVaultIdentity(value) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('vaultName is required');
  const normalized = value.normalize('NFC').trim();
  if (/[%\0-\x1f\x7f?#&]/.test(normalized) || /[\\/]/.test(normalized)) throw new Error('vaultName contains unsafe URL characters');
  return normalized;
}

function buildObsidianArtifactUrl({ vaultName, vaultRelativePath } = {}) {
  const vault = assertVaultIdentity(vaultName);
  const file = normalizeVaultRelativeMarkdownPath(vaultRelativePath);
  return `${OBSIDIAN_RESOLVER_ORIGIN}?vault=${encodeURIComponent(vault)}&file=${encodeURIComponent(file)}`;
}

function buildObsidianArtifactLink({ vaultName, vaultRelativePath, label } = {}) {
  const href = buildObsidianArtifactUrl({ vaultName, vaultRelativePath });
  const text = typeof label === 'string' && label.trim() ? label.trim() : vaultRelativePath;
  return { href, label: text };
}

module.exports = {
  OBSIDIAN_RESOLVER_ORIGIN,
  buildObsidianArtifactLink,
  buildObsidianArtifactUrl,
};
