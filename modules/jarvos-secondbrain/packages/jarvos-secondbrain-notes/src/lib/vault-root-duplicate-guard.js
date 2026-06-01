#!/usr/bin/env node
/**
 * Removes the Obsidian-mobile trap where a zero-byte note at the vault root
 * shadows the populated canonical note in Notes/.
 */

'use strict';

const fs = require('fs');
const path = require('path');

function sanitizeTitle(title) {
  return String(title || '').trim().replace(/[/\\:*?"<>|]/g, '-');
}

function vaultRootForNotesDir(notesDir) {
  if (!notesDir) return null;
  const resolved = path.resolve(notesDir);
  return path.basename(resolved).toLowerCase() === 'notes' ? path.dirname(resolved) : null;
}

function fileStat(filePath) {
  try {
    const stat = fs.statSync(filePath);
    return stat.isFile() ? stat : null;
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    throw error;
  }
}

function repairZeroByteVaultRootDuplicate({
  noteTitle,
  notesDir,
  notesFilePath,
  vaultRoot,
} = {}) {
  const resolvedNotesDir = notesDir ? path.resolve(notesDir) : null;
  const resolvedVaultRoot = vaultRoot ? path.resolve(vaultRoot) : vaultRootForNotesDir(resolvedNotesDir);
  if (!resolvedVaultRoot) {
    return { checked: false, repaired: false, reason: 'vault root unavailable' };
  }

  const noteFileName = notesFilePath
    ? path.basename(notesFilePath)
    : `${sanitizeTitle(noteTitle)}.md`;
  const canonicalPath = notesFilePath
    ? path.resolve(notesFilePath)
    : path.join(resolvedNotesDir || path.join(resolvedVaultRoot, 'Notes'), noteFileName);
  const rootPath = path.join(resolvedVaultRoot, noteFileName);

  if (path.resolve(rootPath) === path.resolve(canonicalPath)) {
    return { checked: false, repaired: false, reason: 'root path matches canonical note path' };
  }

  let rootStat;
  try {
    rootStat = fileStat(rootPath);
  } catch (error) {
    return {
      checked: true,
      repaired: false,
      rootPath,
      notesPath: canonicalPath,
      reason: `could not inspect root duplicate: ${error.message}`,
    };
  }
  if (!rootStat) {
    return { checked: true, repaired: false, rootPath, notesPath: canonicalPath, reason: 'no root duplicate' };
  }

  if (rootStat.size !== 0) {
    return { checked: true, repaired: false, rootPath, notesPath: canonicalPath, reason: 'root duplicate is not zero-byte' };
  }

  let canonicalStat;
  try {
    canonicalStat = fileStat(canonicalPath);
  } catch (error) {
    return {
      checked: true,
      repaired: false,
      rootPath,
      notesPath: canonicalPath,
      reason: `could not inspect canonical Notes file: ${error.message}`,
    };
  }
  if (!canonicalStat || canonicalStat.size === 0) {
    return { checked: true, repaired: false, rootPath, notesPath: canonicalPath, reason: 'matching populated Notes file not found' };
  }

  try {
    fs.unlinkSync(rootPath);
  } catch (error) {
    return {
      checked: true,
      repaired: false,
      rootPath,
      notesPath: canonicalPath,
      reason: `could not remove zero-byte vault-root duplicate: ${error.message}`,
    };
  }
  return { checked: true, repaired: true, rootPath, notesPath: canonicalPath, reason: 'removed zero-byte vault-root duplicate' };
}

module.exports = {
  repairZeroByteVaultRootDuplicate,
  sanitizeTitle,
  vaultRootForNotesDir,
};
