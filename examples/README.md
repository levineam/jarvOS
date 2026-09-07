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
