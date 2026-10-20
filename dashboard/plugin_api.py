"""Read-only Codex quota endpoint for the Hermes token-speed desktop chip.

Credentials are resolved and sent by Hermes core; this plugin never reads or
stores OAuth tokens. The upstream WHAM usage endpoint is undocumented.
"""
from __future__ import annotations

import threading
import time
from typing import Any

from fastapi import APIRouter, HTTPException
from hermes_cli.plugin_provider_requests import (
    ProviderNotSignedIn,
    credentialed_provider_request,
)

router = APIRouter()
_ENDPOINT = "https://chatgpt.com/backend-api/wham/usage"
_CACHE_SECONDS = 60.0
_cache_lock = threading.Lock()
_refresh_lock = threading.Lock()
_cache: dict[str, Any] | None = None
_cache_at = 0.0


def _window(value: Any) -> dict[str, int | float] | None:
    if not isinstance(value, dict):
        return None
    used = value.get("used_percent", value.get("usedPercent"))
    if not isinstance(used, (int, float)) or isinstance(used, bool) or not 0 <= used <= 100:
        return None
    reset = value.get("reset_at", value.get("resetAt"))
    result = {"used_percent": used, "remaining_percent": 100 - used}
    if isinstance(reset, (int, float)) and not isinstance(reset, bool):
        result["resets_at"] = int(reset)
    return result


def parse_usage(payload: Any) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise ValueError("invalid quota response")
    rate = payload.get("rate_limit", payload.get("rateLimit"))
    if not isinstance(rate, dict):
        raise ValueError("quota response omitted rate limits")
    five = _window(rate.get("primary_window", rate.get("primaryWindow")))
    week = _window(rate.get("secondary_window", rate.get("secondaryWindow")))
    if five is None and week is None:
        raise ValueError("quota response omitted usage windows")
    return {"five_hour": five, "weekly": week, "refreshed_at": int(time.time())}


@router.get("/quota")
def codex_quota() -> dict[str, Any]:
    """Return remaining 5-hour and weekly Codex quota, cached briefly."""
    global _cache, _cache_at
    now = time.monotonic()
    with _cache_lock:
        if _cache is not None and now - _cache_at < _CACHE_SECONDS:
            return dict(_cache)
    # Do not hold the cache lock while waiting for network I/O; coalesce concurrent refreshes.
    with _refresh_lock:
        now = time.monotonic()
        with _cache_lock:
            if _cache is not None and now - _cache_at < _CACHE_SECONDS:
                return dict(_cache)
        try:
            response = credentialed_provider_request(
                "openai-codex", "GET", _ENDPOINT,
                headers={"Accept": "application/json", "User-Agent": "codex-cli"},
                timeout=10.0,
            )
            if response.status != 200:
                raise RuntimeError(f"quota endpoint returned HTTP {response.status}")
            result = parse_usage(response.json())
        except ProviderNotSignedIn as exc:
            raise HTTPException(status_code=401, detail="Codex is not signed in through Hermes") from exc
        except Exception as exc:
            # Do not return response bodies, headers, or credential-bearing details to the UI.
            raise HTTPException(status_code=502, detail="Codex quota is temporarily unavailable") from exc
        with _cache_lock:
            _cache = result
            _cache_at = time.monotonic()
            return dict(_cache)
