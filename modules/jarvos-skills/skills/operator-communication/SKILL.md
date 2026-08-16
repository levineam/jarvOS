---
name: operator-communication
description: Communicate jarvOS operational conditions in plain language without exposing diagnostics or inventing a delivery channel.
triggers:
  - operator notification
  - release ready
  - recovery failed
  - safety hold
  - tell the operator
metadata:
  jarvos:
    bundle: operating-system-skills
    portability: generic
    contract: jarvos-operator-notification/v1
---

# Operator Communication

Use this skill when jarvOS needs to explain an operational condition to the
operator. It controls message semantics, not delivery: the owning runtime may
present an approved message through its configured local surface, but this
public skill neither selects nor configures that surface.

## Contract

The workflow is complete only when the operator can tell:

- what happened
- what jarvOS did to preserve safety
- whether an action is required and, if so, the reviewed choice
- what jarvOS will do next

Use the versioned `jarvos-operator-notification/v1` event contract and its
deterministic renderer. For routine safe repairs or resolutions, return
`NO_REPLY`. For safety holds and stale observations, preserve a durable status
without escalating a routine event into an interruption. For an action-required
event, include only its opaque reference for follow-up.

## Boundaries

- Do not render source paths, command output, stack traces, commit IDs,
  credentials, private receipt content, raw diagnostic codes, or caller-supplied
  prose.
- Do not claim that a release is current, approval-ready, or publishable from
  stale or unknown evidence.
- Do not send Telegram, email, calendar, chat, push, or any other external
  notification from this skill. Delivery belongs to an explicitly configured,
  owner-authorized runtime adapter.
- Do not turn a safe hold, repair, or resolution into a request for operator
  action unless the semantic event explicitly requires a reviewed action.

## Decision guide

1. Validate a typed semantic event before rendering.
2. For `direct-notification`, present the rendered plain-English output once,
   using local deduplication keyed by the contract's dedupe identity.
3. For `durable-status`, record the renderer's status text in the owner-owned
   status surface and return `NO_REPLY` to the immediate channel.
4. For `quiet`, return `NO_REPLY` and retain any detailed evidence only in its
   owner-authorized private system.

## Completion evidence

- the event validates against `jarvos-operator-notification/v1`
- the output is deterministic and contains no unreviewed diagnostic detail
- any delivery claim is supported by the selected runtime's local configuration
- the adapter still declares delivery as unconfigured when no such proof exists
