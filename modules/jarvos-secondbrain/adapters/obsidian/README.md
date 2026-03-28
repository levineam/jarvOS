# adapters/obsidian

Obsidian/Vault-backed adapter surfaces for `jarvos-secondbrain`.

## Current implementation

- `src/vault-storage-adapter.js`
  - ensures the daily journal exists using the package-owned journal contract
  - appends routed lines into the correct journal section
  - writes standalone notes through the package-owned note writer
  - links newly created notes back into the journal

## Purpose

This adapter is the storage-specific layer for the current Vault/Obsidian setup.
Routing policy stays in `bridge/routing`, while package ownership stays inside the
journal and notes packages.
