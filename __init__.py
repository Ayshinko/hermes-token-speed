"""Hermes token speed: signed Codex quota API support.

The desktop contribution lives in desktop/plugin.js. The agent side exists to
mount the dashboard API in the same Hermes profile; it deliberately registers
no tools or hooks.
"""


def register(ctx) -> None:
    """Enable the package's dashboard API without adding agent-facing actions."""
    return None
