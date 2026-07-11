"""Batonpass helper plugin for Hermes Agent.

Writes the same signals the orchestrator's other adapters get from native
hooks: usage.json on every LLM API call, and a turn-idle marker at the end of
every turn. Pure stdlib, dependency-free (mirrors docs/adapters.md's
zero-dependency-hook doctrine, applied here to Hermes's Python plugin system):
no imports beyond the standard library, atomic writes via tmp+os.replace, no
network, no blocking I/O beyond tiny local files, and every handler body is
wrapped in try/except so a bug here can never break a user's turn (Hermes'
own PluginManager.invoke_hook already catches per-callback exceptions and
logs a warning, but a handler should never rely on that as its only guard).

Inert everywhere else: it is enabled globally once `hermes plugins enable
batonpass` runs, so every handler first checks that $BATONPASS_DIR is set
and exists, and does nothing at all otherwise. This is the only thing that
keeps a plugin running in EVERY Hermes session from touching non-batonpass
projects.
"""

import json
import os
import time


def _batonpass_dir():
    d = os.environ.get("BATONPASS_DIR")
    if not d or not os.path.isdir(d):
        return None
    return d


def _now_iso():
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def _write_atomic(path, data):
    tmp = f"{path}.tmp-{os.getpid()}"
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(data)
    os.replace(tmp, path)


def _get_cached_context_length(model, base_url):
    # Imported lazily, inside the handler: never import Hermes internals at
    # plugin-module load time (breaks the "never raise" guarantee if Hermes's
    # internal layout shifts) and never call the network-probing variant from
    # a synchronous hook (agent/model_metadata.py:1117, get_cached_context_length
    # is the local-cache-only lookup; get_model_context_length is not).
    from agent.model_metadata import get_cached_context_length

    return get_cached_context_length(model, base_url)


def _on_session_start(**kwargs):
    # Fired once for a brand-new session (not on --resume/continuation —
    # agent/conversation_loop.py:363-375). Clears any usage.json left behind by
    # a previous session in this same .batonpass dir so a fresh session doesn't
    # inherit a stale near-threshold reading and trip the orchestrator
    # immediately on respawn.
    try:
        d = _batonpass_dir()
        if d is None:
            return
        payload = {"pct": None, "tokens": 0, "max": None, "source": "hermes-session-start-reset", "updatedAt": _now_iso()}
        _write_atomic(os.path.join(d, "usage.json"), json.dumps(payload))
    except Exception:
        pass


def _on_api_request(**kwargs):
    try:
        d = _batonpass_dir()
        if d is None:
            return
        usage = kwargs.get("usage") or {}
        tokens = usage.get("prompt_tokens")
        if tokens is None:
            return

        max_tokens = None
        try:
            max_tokens = _get_cached_context_length(kwargs.get("model"), kwargs.get("base_url"))
        except Exception:
            max_tokens = None

        pct = (tokens / max_tokens) if max_tokens else None
        payload = {
            "pct": pct,
            "tokens": tokens,
            "max": max_tokens,
            "source": "hermes-post-api-request",
            "updatedAt": _now_iso(),
        }
        _write_atomic(os.path.join(d, "usage.json"), json.dumps(payload))
    except Exception:
        pass


def _on_turn_end(**kwargs):
    try:
        d = _batonpass_dir()
        if d is None:
            return
        payload = {
            "idleAt": _now_iso(),
            "sessionId": kwargs.get("session_id"),
            "turnId": kwargs.get("turn_id"),
        }
        _write_atomic(os.path.join(d, "turn-idle"), json.dumps(payload))
    except Exception:
        pass


def _on_baton_command(raw_args):
    # Manual trigger, mirrors Claude Code's /handoff. Only writes a marker
    # file today — the orchestrator does not yet poll it (same as Claude
    # Code's own /handoff, which the agent acts on directly rather than the
    # orchestrator). Wiring that up is tracked as a follow-up, not this plan.
    try:
        d = _batonpass_dir()
        if d is None:
            return "batonpass is not active in this session ($BATONPASS_DIR is not set)."
        _write_atomic(os.path.join(d, "manual-handoff-requested"), _now_iso())
        return "Batonpass: handoff requested."
    except Exception:
        return None


def register(ctx):
    ctx.register_hook("on_session_start", _on_session_start)
    ctx.register_hook("post_api_request", _on_api_request)
    ctx.register_hook("post_llm_call", _on_turn_end)
    ctx.register_command(
        "baton",
        _on_baton_command,
        description="Request a Batonpass handoff (writes a marker; manual consumption today, same as Claude Code's /handoff).",
    )
