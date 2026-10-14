"""Bounded first-turn jarvOS context injection for Hermes Agent.

Hermes calls ``on_session_start`` when a new session is built and allows
``pre_llm_call`` plugins to return ephemeral user-message context. This plugin
uses those documented hooks only; it never polls, persists packet content, or
changes Hermes-native session state. When configured, it also asks the
private owner-only jarvOS context bridge for an opaque route capability. The
raw route tuple and bridge credential never enter the prompt or a handoff.
"""

from __future__ import annotations

import os
import queue
import re
import hashlib
import hmac
import json
import socket
import threading
import time
import uuid
from typing import Any

_PACKET_HEADER = "# jarvOS Working Context Packet"
_MAX_CHARS = 6000
_SESSION_ID = re.compile(r"^[A-Za-z0-9._:-]{1,200}$")
_ROUTE_VALUE = re.compile(r"^[^\x00-\x1f\x7f]{1,512}$")
_BRIDGE_SCHEMA = "jarvos-hermes-context-capability.v1"
_BRIDGE_ACTION = "issue"


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


def _route_value(value: Any, fallback: str | None = None) -> str | None:
    candidate = value if isinstance(value, str) and value else fallback
    if not isinstance(candidate, str) or not _ROUTE_VALUE.fullmatch(candidate):
        return None
    return candidate.strip()


def _read_credential() -> str | None:
    credential_file = os.environ.get("JARVOS_HERMES_CONTEXT_BRIDGE_CREDENTIAL_FILE", "").strip()
    if credential_file:
        try:
            stat = os.stat(credential_file)
            if stat.st_mode & 0o077 or stat.st_uid != os.getuid():
                return None
            with open(credential_file, "r", encoding="utf-8") as handle:
                value = handle.read().strip()
            return value if len(value) >= 16 else None
        except (OSError, ValueError):
            return None
    value = os.environ.get("JARVOS_HERMES_CONTEXT_BRIDGE_CREDENTIAL", "").strip()
    return value if len(value) >= 16 else None


def _canonical_request(request: dict[str, Any]) -> bytes:
    values = [
        request.get("schemaVersion"),
        request.get("action"),
        request.get("credentialRevision"),
        request.get("harness"),
        request.get("profile"),
        request.get("platform"),
        request.get("conversation"),
        request.get("sender"),
        request.get("nativeSession"),
        request.get("generation"),
        request.get("timestamp"),
        request.get("nonce"),
    ]
    return json.dumps(values, ensure_ascii=False, separators=(",", ":")).encode("utf-8")


def _request_route_capability(kwargs: dict[str, Any]) -> str | None:
    """Obtain a short-lived capability from the private bridge.

    A missing or unavailable bridge prevents automatic hydration so private
    context is never injected into a session whose route was not authorized.
    """
    socket_path = os.environ.get("JARVOS_HERMES_CONTEXT_BRIDGE_SOCKET", "").strip()
    credential = _read_credential()
    if not socket_path or not credential:
        return None
    platform = _route_value(kwargs.get("platform"))
    session_id = _route_value(kwargs.get("session_id"))
    if not platform or not session_id:
        return None
    request = {
        "schemaVersion": _BRIDGE_SCHEMA,
        "action": _BRIDGE_ACTION,
        "credentialRevision": os.environ.get("JARVOS_HERMES_CONTEXT_BRIDGE_CREDENTIAL_REVISION", "credential-1").strip() or "credential-1",
        "harness": "hermes",
        "profile": _route_value(kwargs.get("profile"), os.environ.get("JARVOS_HERMES_CONTEXT_BRIDGE_PROFILE", "default")),
        "platform": platform,
        "conversation": _route_value(
            kwargs.get("conversation") or kwargs.get("conversation_id") or kwargs.get("chat_id"),
            session_id,
        ),
        "sender": _route_value(
            kwargs.get("sender") or kwargs.get("sender_id") or kwargs.get("user_id"),
            "hermes-user",
        ),
        "nativeSession": session_id,
        "generation": os.environ.get("JARVOS_HERMES_CONTEXT_BRIDGE_GENERATION", "hermes-jarvos.v1").strip() or "hermes-jarvos.v1",
        "timestamp": int(time.time() * 1000),
        "nonce": uuid.uuid4().hex,
    }
    if any(value is None for value in request.values()):
        return None
    request["mac"] = hmac.new(credential.encode("utf-8"), _canonical_request(request), hashlib.sha256).hexdigest()
    timeout = _timeout_seconds()
    try:
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as channel:
            channel.settimeout(timeout)
            channel.connect(socket_path)
            channel.sendall((json.dumps(request, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8"))
            chunks: list[bytes] = []
            while sum(len(chunk) for chunk in chunks) <= 65536:
                chunk = channel.recv(4096)
                if not chunk:
                    break
                chunks.append(chunk)
                if b"\n" in chunk:
                    break
        response = json.loads(b"".join(chunks).split(b"\n", 1)[0].decode("utf-8"))
        capability = response.get("routeCapability") if isinstance(response, dict) and response.get("ok") else None
        return capability if isinstance(capability, str) and 32 <= len(capability) <= 4096 else None
    except (OSError, ValueError, json.JSONDecodeError):
        return None


def _call_bounded(ctx: Any, kwargs: dict[str, Any]) -> str | None:
    result: queue.Queue[object] = queue.Queue(maxsize=1)

    def dispatch() -> None:
        try:
            capability = _request_route_capability(kwargs)
            if not capability:
                result.put(None)
                return
            # Require the private bridge to authorize the route before asking
            # for any hydration data, not only the route-bound live thread.
            args: dict[str, Any] = {
                "maxChars": _MAX_CHARS,
                "sessionThread": {"routeCapability": capability},
            }
            result.put(ctx.dispatch_tool("jarvos_hydrate", args))
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
        packet = _call_bounded(ctx, kwargs)
        return {"context": packet} if packet is not None else None

    ctx.register_hook("on_session_start", on_session_start)
    ctx.register_hook("on_session_reset", on_session_reset)
    ctx.register_hook("pre_llm_call", pre_llm_call)
