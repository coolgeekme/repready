"""Pure helpers for validating Composio email connection state."""

from typing import Optional


def active_connection_id(item) -> Optional[str]:
    """Return an ID only for a real, active Composio connection."""
    if isinstance(item, dict):
        connection_id = item.get("id")
        status = item.get("status")
    else:
        connection_id = getattr(item, "id", None)
        status = getattr(item, "status", None)
    status = getattr(status, "value", status)
    if str(status or "").upper() != "ACTIVE":
        return None
    return str(connection_id).strip() if connection_id else None
