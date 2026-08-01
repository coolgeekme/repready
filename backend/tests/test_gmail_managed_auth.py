"""Focused pytest for Gmail managed OAuth + email/status tightening.

Covers the fix that (a) forces Gmail through Composio's managed auth config
(ignoring the customized `GMAIL_AUTH_CONFIG_ID`) and (b) reports
`connected=true` only when there is an ACTIVE record with a real
`connection_id`. INITIALIZING/EXPIRED/DROPPED records must never count as
connected.
"""
from __future__ import annotations

import importlib
import sys

import pytest
from fastapi.testclient import TestClient


sys.path.insert(0, "/app/backend")
server = importlib.import_module("server")


class _FakeAuthConfigsList:
    def __init__(self, items):
        self.items = items


class _FakeAuthConfig:
    def __init__(self, id_, managed=True):
        self.id = id_
        self.is_composio_managed = managed


class _FakeCreatedAuthConfig:
    def __init__(self, id_):
        self.id = id_


class _FakeConnected:
    def __init__(self, id_, status):
        self.id = id_
        self.status = status


class _FakeConnListing:
    def __init__(self, items):
        self.items = items


class _FakeClient:
    """Minimal fake Composio client for isolating server.py logic under test."""
    def __init__(self, *, list_items=None, list_managed_items=None, connected_items=None, link_result=None):
        self._list_managed_items = list_managed_items if list_managed_items is not None else []
        self._connected_items = connected_items if connected_items is not None else []
        self._link_result = link_result
        self._created_id = None

        class _AuthConfigs:
            def __init__(inner):
                inner._parent = self
            def list(inner, **kw):
                assert kw.get("toolkit_slug") == "gmail"
                assert bool(kw.get("is_composio_managed")) is True
                return _FakeAuthConfigsList(inner._parent._list_managed_items)
            def create(inner, toolkit, options):
                assert toolkit == "gmail"
                assert options == {"type": "use_composio_managed_auth"}
                inner._parent._created_id = "ac_MANAGED_CREATED"
                return _FakeCreatedAuthConfig("ac_MANAGED_CREATED")

        class _ConnectedAccounts:
            def __init__(inner):
                inner._parent = self
            def list(inner, **kw):
                return _FakeConnListing(inner._parent._connected_items)
            def link(inner, **kw):
                # Should be called with the MANAGED auth_config_id, never the
                # customized `ac_PB3OpzQ4iyZ_` one from env.
                assert kw["auth_config_id"] != "ac_PB3OpzQ4iyZ_", (
                    "Gmail must not use the customized env var auth_config_id"
                )
                assert kw["auth_config_id"].startswith("ac_"), kw
                if inner._parent._link_result is None:
                    class R: redirect_url = "https://connect.composio.dev/link/lk_TEST"
                    return R()
                return inner._parent._link_result

        self.auth_configs = _AuthConfigs()
        self.connected_accounts = _ConnectedAccounts()


@pytest.fixture(autouse=True)
def reset_managed_cache(monkeypatch):
    # Ensure each test gets a clean module-level cache.
    monkeypatch.setattr(server, "_MANAGED_GMAIL_AUTH_CONFIG_ID", None)
    # Also ensure env var IS set to the customized value so we can verify it's
    # deliberately ignored.
    monkeypatch.setenv("GMAIL_AUTH_CONFIG_ID", "ac_PB3OpzQ4iyZ_")
    monkeypatch.setitem(server.EMAIL_AUTH_CONFIGS, "gmail", "ac_PB3OpzQ4iyZ_")
    yield


# ---------- Managed Gmail auth config resolution ----------
def test_gmail_uses_existing_managed_auth_config(monkeypatch):
    fake = _FakeClient(list_managed_items=[_FakeAuthConfig("ac_EXISTING_MANAGED")])
    monkeypatch.setattr(server, "_composio_client", lambda: fake)
    resolved = server._get_managed_gmail_auth_config_id()
    assert resolved == "ac_EXISTING_MANAGED"
    assert resolved != "ac_PB3OpzQ4iyZ_"


def test_gmail_creates_managed_auth_config_if_missing(monkeypatch):
    fake = _FakeClient(list_managed_items=[])
    monkeypatch.setattr(server, "_composio_client", lambda: fake)
    resolved = server._get_managed_gmail_auth_config_id()
    assert resolved == "ac_MANAGED_CREATED"
    assert resolved != "ac_PB3OpzQ4iyZ_"


def test_gmail_managed_id_is_cached(monkeypatch):
    """Second call must not hit the API again."""
    calls = {"list": 0, "create": 0}

    class _Counting(_FakeClient):
        def __init__(self):
            super().__init__(list_managed_items=[_FakeAuthConfig("ac_CACHED")])
            outer_list = self.auth_configs.list
            outer_create = self.auth_configs.create
            def list_wrap(**kw):
                calls["list"] += 1
                return outer_list(**kw)
            def create_wrap(*a, **kw):
                calls["create"] += 1
                return outer_create(*a, **kw)
            self.auth_configs.list = list_wrap
            self.auth_configs.create = create_wrap

    fake = _Counting()
    monkeypatch.setattr(server, "_composio_client", lambda: fake)
    a = server._get_managed_gmail_auth_config_id()
    b = server._get_managed_gmail_auth_config_id()
    assert a == b == "ac_CACHED"
    assert calls["list"] == 1  # only first call hits API
    assert calls["create"] == 0


# ---------- Connect endpoint uses managed auth ----------
def test_gmail_connect_uses_managed_auth_config(monkeypatch):
    fake = _FakeClient(list_managed_items=[_FakeAuthConfig("ac_MANAGED_XYZ")])
    monkeypatch.setattr(server, "_composio_client", lambda: fake)
    tc = TestClient(server.app)
    r = tc.post("/api/email/gmail/connect", headers={"X-User-Id": "u1"})
    assert r.status_code == 200, r.text
    j = r.json()
    assert j["provider"] == "gmail"
    assert j["redirect_url"].startswith("https://connect.composio.dev/link/")


# ---------- Status endpoint tightening ----------
def test_status_ignores_records_without_id(monkeypatch):
    fake = _FakeClient(
        list_managed_items=[_FakeAuthConfig("ac_MANAGED")],
        connected_items=[_FakeConnected(None, "ACTIVE"), _FakeConnected("", "ACTIVE")],
    )
    monkeypatch.setattr(server, "_composio_client", lambda: fake)
    tc = TestClient(server.app)
    r = tc.get("/api/email/gmail/status", headers={"X-User-Id": "u1"})
    j = r.json()
    assert r.status_code == 200
    assert j["connected"] is False
    assert j["connection_id"] is None


def test_status_ignores_non_active_records(monkeypatch):
    """INITIALIZING and DROPPED records must not report connected=true."""
    for bad_status in ("INITIALIZING", "EXPIRED", "FAILED", "DROPPED", "REVOKED"):
        fake = _FakeClient(
            list_managed_items=[_FakeAuthConfig("ac_MANAGED")],
            connected_items=[_FakeConnected("ca_maybe", bad_status)],
        )
        monkeypatch.setattr(server, "_composio_client", lambda: fake)
        monkeypatch.setattr(server, "_MANAGED_GMAIL_AUTH_CONFIG_ID", None)
        tc = TestClient(server.app)
        r = tc.get("/api/email/gmail/status", headers={"X-User-Id": "u1"})
        j = r.json()
        assert r.status_code == 200
        assert j["connected"] is False, f"status={bad_status} leaked as connected"
        assert j["connection_id"] is None


def test_status_reports_active_connection(monkeypatch):
    fake = _FakeClient(
        list_managed_items=[_FakeAuthConfig("ac_MANAGED")],
        connected_items=[_FakeConnected("ca_real_123", "ACTIVE")],
    )
    monkeypatch.setattr(server, "_composio_client", lambda: fake)
    tc = TestClient(server.app)
    r = tc.get("/api/email/gmail/status", headers={"X-User-Id": "u1"})
    j = r.json()
    assert r.status_code == 200
    assert j["connected"] is True
    assert j["connection_id"] == "ca_real_123"
    assert j["configured"] is True


# ---------- Response shape preservation ----------
def test_status_response_shape_unchanged(monkeypatch):
    """Mobile UI expects: {provider, connected, configured, connection_id?}."""
    fake = _FakeClient(
        list_managed_items=[_FakeAuthConfig("ac_MANAGED")],
        connected_items=[_FakeConnected("ca_x", "ACTIVE")],
    )
    monkeypatch.setattr(server, "_composio_client", lambda: fake)
    tc = TestClient(server.app)
    r = tc.get("/api/email/gmail/status", headers={"X-User-Id": "u1"})
    j = r.json()
    for k in ("provider", "connected", "configured", "connection_id"):
        assert k in j, f"missing key {k} in status response {j}"


def test_outlook_still_uses_env_auth_config(monkeypatch):
    """Outlook must be untouched by the Gmail-managed logic."""
    monkeypatch.setitem(server.EMAIL_AUTH_CONFIGS, "outlook", "ac_OUTLOOK_ENV")
    resolved = server._resolve_email_auth_config_id("outlook")
    assert resolved == "ac_OUTLOOK_ENV"
