# adapters/openclaw

OpenClaw session source adapter for the jarvOS automatic secondbrain pipeline.

`createOpenClawSessionAdapter()` accepts parsed OpenClaw session records and
normalizes them into source-backed `CaptureEvent` v2 objects. Runtime code should
own file discovery and parsing; this adapter owns the public-safe event contract.

The adapter defaults to `local-private` and skips `secret` sessions instead of
emitting content.
