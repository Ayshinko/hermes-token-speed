"""Tests for the Codex quota parser and cached API response shape."""
from __future__ import annotations

import importlib.util
import sys
import threading
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from fastapi import HTTPException

MODULE_PATH = Path(__file__).parent.parent / "dashboard" / "plugin_api.py"
spec = importlib.util.spec_from_file_location("hermes_token_speed_api_test", MODULE_PATH)
api = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = api
spec.loader.exec_module(api)


def test_parse_quota_and_remaining_percent():
    result = api.parse_usage({"rate_limit": {
        "primary_window": {"used_percent": 7, "reset_at": 1792461354},
        "secondary_window": {"used_percent": 12, "reset_at": 1792874487},
    }})
    assert result["five_hour"] == {"used_percent": 7, "remaining_percent": 93, "resets_at": 1792461354}
    assert result["weekly"] == {"used_percent": 12, "remaining_percent": 88, "resets_at": 1792874487}
    assert isinstance(result["refreshed_at"], int)


def test_parse_quota_accepts_camel_case_and_omitted_window():
    result = api.parse_usage({"rateLimit": {"primaryWindow": {"usedPercent": 100}}})
    assert result["five_hour"]["remaining_percent"] == 0
    assert result["weekly"] is None


def test_parse_rejects_invalid_or_missing_windows():
    for body in ({}, {"rate_limit": {"primary_window": {"used_percent": 101}}}, None):
        try:
            api.parse_usage(body)
        except ValueError:
            continue
        raise AssertionError(f"accepted malformed quota response {body!r}")


def test_endpoint_uses_hermes_signed_provider_request_and_caches():
    api._cache = None
    fake = SimpleNamespace(status=200, json=lambda: {"rate_limit": {
        "primary_window": {"used_percent": 10}, "secondary_window": {"used_percent": 20},
    }})
    with patch.object(api, "credentialed_provider_request", return_value=fake) as request:
        first = api.codex_quota()
        second = api.codex_quota()
    assert first == second
    assert request.call_count == 1
    args, kwargs = request.call_args
    assert args[:2] == ("openai-codex", "GET")
    assert args[2] == "https://chatgpt.com/backend-api/wham/usage"
    assert kwargs["headers"] == {"Accept": "application/json", "User-Agent": "codex-cli"}


def test_endpoint_does_not_leak_upstream_error_details():
    api._cache = None
    with patch.object(api, "credentialed_provider_request", side_effect=RuntimeError("secret-bearing upstream body")):
        try:
            api.codex_quota()
        except HTTPException as exc:
            assert exc.status_code == 502
            assert "secret-bearing" not in str(exc.detail)
        else:
            raise AssertionError("upstream failure should return HTTP 502")


def test_endpoint_coalesces_concurrent_cache_misses():
    api._cache = None
    fake = SimpleNamespace(status=200, json=lambda: {"rate_limit": {
        "primary_window": {"used_percent": 10}}})
    barrier = threading.Barrier(6)
    results = []
    failures = []
    def worker():
        try:
            barrier.wait()
            results.append(api.codex_quota())
        except Exception as exc:
            failures.append(exc)
    with patch.object(api, "credentialed_provider_request", return_value=fake) as request:
        threads = [threading.Thread(target=worker) for _ in range(6)]
        for thread in threads: thread.start()
        for thread in threads: thread.join(timeout=3)
    assert not failures, failures
    assert len(results) == 6
    assert request.call_count == 1


if __name__ == "__main__":
    for test in (
        test_parse_quota_and_remaining_percent,
        test_parse_quota_accepts_camel_case_and_omitted_window,
        test_parse_rejects_invalid_or_missing_windows,
        test_endpoint_uses_hermes_signed_provider_request_and_caches,
        test_endpoint_does_not_leak_upstream_error_details,
        test_endpoint_coalesces_concurrent_cache_misses,
    ):
        test()
    print("6 quota API tests passed")
