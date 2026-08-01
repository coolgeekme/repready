"""Focused regression tests for Composio email connection state."""

from types import SimpleNamespace

from email_connections import active_connection_id


def test_active_connection_requires_real_id():
    assert active_connection_id({"status": "ACTIVE"}) is None


def test_non_active_connection_is_ignored():
    assert active_connection_id({"id": "ca_pending", "status": "INITIALIZING"}) is None


def test_active_dict_connection_returns_id():
    assert active_connection_id({"id": "ca_live", "status": "ACTIVE"}) == "ca_live"


def test_active_sdk_object_connection_returns_id():
    status = SimpleNamespace(value="ACTIVE")
    item = SimpleNamespace(id="ca_sdk", status=status)
    assert active_connection_id(item) == "ca_sdk"
