# Examples

Public examples and copy-into-workspace templates. None of these files is a
live host binding; private paths stay in the operator's workspace.

## Todo work-action host service

`work-action-host-service.js` is the module `JARVOS_WORK_ACTION_SERVICE_MODULE`
can point at after you copy it into the selected Projects `workspaceRoot` as an
owner-only regular file (mode 0600).

The MCP server refuses any module outside that workspace. Runtime setup
scripts pass the two optional host env vars through to the MCP child when set:

- `JARVOS_WORK_ACTION_SERVICE_MODULE` — absolute path of the copied module
- `JARVOS_PROJECTS_CONTEXT_CONFIG` — absolute path of the Projects context
  config whose `workspaceRoot` contains that module

Leave both unset on a public/minimal install. Beads workspace location comes
from the host config (`beadsWorkspace`, else `workspaceRoot`).

The host config must also supply `beadsExecutable`: a canonical absolute path
to the host-owned Beads executable. The real adapter validates the file and
every ancestor: no symlinks, untrusted owners, or group/world-writable paths
(sticky temporary directories are allowed). Basenames, relative paths and
ambient `PATH` discovery are refused. This field is passed as the adapter's
existing `executable` option; it is separate from `beadsWorkspace`.
