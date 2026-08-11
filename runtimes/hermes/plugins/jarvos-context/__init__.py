"""Bounded first-turn jarvOS context injection for Hermes Agent.

Hermes calls ``on_session_start`` when a new session is built and allows
``pre_llm_call`` plugins to return ephemeral user-message context. This plugin
uses those documented hooks only; it never polls, persists packet content, or
changes Hermes-native session state.
"""

from __future__ import annotations

import os
import queue
import re
import threading
from typing import Any

_PACKET_HEADER = "# jarvOS Working Context Packet"
_MAX_CHARS = 6000
_SESSION_ID = re.compile(r"^[A-Za-z0-9._:-]{1,200}$")


def _timeout_seconds() -> float:
    try:
        return max(0.01, min(float(os.environ.get("JARVOS_HERMES_HYDRATE_TIMEOUT_SECONDS", "2")), 10.0))
    except ValueError:
        return 2.0


def _route_key(kwargs: dict[str, Any]) -> tuple[str, str] | None:
    session_id = kwargs.get("session_id")
    platform = kwargs.get("platform")
    if not isinstance(session_id, str) or not _SESSION_ID.fullmatch(session_id):
        return None
    if not isinstance(platform, str) or not platform or len(platform) > 80:
        return None
    return platform, session_id


def _call_bounded(ctx: Any) -> str | None:
    result: queue.Queue[object] = queue.Queue(maxsize=1)

    def dispatch() -> None:
        try:
            result.put(ctx.dispatch_tool("jarvos_hydrate", {"maxChars": _MAX_CHARS}))
        except Exception:
            result.put(None)

    thread = threading.Thread(target=dispatch, daemon=True)
    thread.start()
    try:
        value = result.get(timeout=_timeout_seconds())
    except queue.Empty:
        return None  # fail open: never delay a user turn for hydration.
    if not isinstance(value, str) or len(value) > _MAX_CHARS:
        return None
    if not value.startswith(_PACKET_HEADER):
        return None
    return value


def register(ctx: Any) -> None:
    """Register only documented Hermes lifecycle hooks."""
    pending: set[tuple[str, str]] = set()
    lock = threading.Lock()

    def on_session_start(**kwargs: Any) -> None:
        key = _route_key(kwargs)
        if key is not None:
            with lock:
                pending.add(key)

    def on_session_reset(**kwargs: Any) -> None:
        key = _route_key(kwargs)
        if key is not None:
            with lock:
                pending.discard(key)

    def pre_llm_call(**kwargs: Any) -> dict[str, str] | None:
        key = _route_key(kwargs)
        if key is None:
            return None
        with lock:
            if key not in pending:
                return None
            pending.remove(key)
        packet = _call_bounded(ctx)
        return {"context": packet} if packet is not None else None

    ctx.register_hook("on_session_start", on_session_start)
    ctx.register_hook("on_session_reset", on_session_reset)
    ctx.register_hook("pre_llm_call", pre_llm_call)
