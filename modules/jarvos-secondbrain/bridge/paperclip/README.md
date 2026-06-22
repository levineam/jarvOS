# jarvos-secondbrain bridge/paperclip

Paperclip bridge code lives here so content-facing jarvOS modules can talk to
the Paperclip tracker without importing root `clawd` script internals.

- `client.js` is the canonical HTTP client for issue creation, issue updates,
  comments, search, and issue lookup.
- `scripts/lib/paperclip-http.js` remains as a root compatibility shim for
  older callers while request/auth/retry logic lives in this bridge.
