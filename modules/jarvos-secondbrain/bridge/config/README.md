# jarvos-secondbrain bridge/config

Shared configuration resolution for jarvOS bridge and compatibility code.

Use `resolveConfig()` instead of reading `jarvos.config.json`, shell env files, or homedir paths directly:

```js
const { resolveConfig } = require('../config');

const config = resolveConfig();
const notesDir = config.paths.notes;
```

Resolution order is portable:

1. Explicit options and environment variables
2. `jarvos.config.json` from `CLAWD_DIR`, `JARVOS_CONFIG_PATH`, or the current workspace shim
3. XDG config at `$XDG_CONFIG_HOME/jarvos/config.json` when present
4. Homedir-relative defaults such as `~/clawd` and `~/Vaults/Vault v3`

Paperclip callers should use `resolvePaperclipConfig()` so env values win while `config/paperclip-env.sh` remains a compatibility fallback. The parser reads shell-style assignment lines without executing the file.
