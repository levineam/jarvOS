# Hard-capture host adapters

Public jarvOS owns strict-command grammar, semantic routing, canonical writes,
artifact receipts, and receipt-derived user responses. A private host adapter
owns caller authorization and the host-runtime transition that prevents a
recognized command from reaching a language model.

A host adapter must use its earliest native pre-model terminal-ownership hook.
For OpenClaw 2026.7.1, that hook is `before_dispatch`: `{ handled: true, text }`
ends dispatch and sends `text` through the normal final-delivery pipeline.
Other hosts may expose a different hook name, but must preserve the same
semantic contract.

Adapters must not:

- copy the public command grammar or redefine command routes;
- confirm capture without an acknowledged artifact receipt;
- combine a direct channel send with a host block or error response;
- depend on a downstream callback without proving that the selected terminal
  path reaches it; or
- treat a manually invoked test callback as host-lifecycle evidence.

Conformance tests must cover recognized, bare, ambient, unauthorized, and
receipt-failure inputs. They must assert one capture attempt, one terminal
response owner, no model dispatch, and no duplicate observer-side capture.
Installed-runtime acceptance must additionally bind one inbound command to one
write, one outbound response, and zero provider starts. Unit tests and a healthy
gateway do not replace that live causal proof.
