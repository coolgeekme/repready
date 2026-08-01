"""Regression tests for the social status + accounts safeguards.

Mirrors the ACTIVE + truthy-connection-ID tightening that was previously
applied to `/api/email/{provider}/status` — now enforced for
`/api/social/{platform}/status` and `/api/social/{platform}/accounts`.

Coverage matrix:
  * Both dict-shape and SDK-object-shape Composio responses.
  * INITIALIZING / EXPIRED / FAILED / DROPPED / REVOKED must never count as
    connected, and must not appear in the account list.
  * ID-less items must never count as connected or appear in the account list.
  * A real ACTIVE record with a truthy id DOES surface — so existing
    LinkedIn/Facebook/Instagram accounts and posting behaviour are preserved.
"""
from __future__ import annotations

import importlib
import sys

import pytest
from fastapi.testclient import TestClient


sys.path.insert(0, "/app/backend")
server = importlib.import_module("server")


PLATFORMS = ["linkedin", "facebook", "instagram"]


# ---------- Object-shape record ----------
class _ObjConn:
    def __init__(self, id_, status, created_at="2026-08-01T00:00:00Z"):
        self.id = id_
        self.status = status
        self.created_at = created_at


class _FakeListing:
    """Composio SDK returns a listing-like object with `.items`; some code
    paths iterate it directly, so we support both."""
    def __init__(self, items):
        self.items = items
    def __iter__(self):
        return iter(self.items)
    def __bool__(self):
        return True


class _FakeClient:
    """Minimal Composio double that returns whatever items the test supplies."""
    def __init__(self, items):
        self._items = items
        self.list_calls = 0
        _self = self

        class _ConnectedAccounts:
            def list(inner, **kw):
                _self.list_calls += 1
                return _FakeListing(_self._items)

        class _Tools:
            def execute(inner, **kw):
                # LinkedIn info fetch — return a benign empty payload so the
                # `display_name` branch doesn't blow up.
                return {"data": {}}

        self.connected_accounts = _ConnectedAccounts()
        self.tools = _Tools()


@pytest.fixture(autouse=True)
def enable_platforms(monkeypatch):
    """Ensure each social platform has an auth_config_id so endpoints run
    past the 'not configured' short-circuit even in a fresh test env."""
    for p in PLATFORMS:
        monkeypatch.setitem(server.SOCIAL_AUTH_CONFIGS, p, f"ac_TEST_{p.upper()}")
    yield


def _dict(id_=None, status=None, created_at=None):
    """Compact helper for dict-shape records."""
    d = {}
    if id_ is not None: d["id"] = id_
    if status is not None: d["status"] = status
    if created_at is not None: d["created_at"] = created_at
    return d


# ---------- Helper unit tests ----------
def test_is_active_connection_recognises_object_shape():
    assert server._is_active_connection(_ObjConn("ca_x", "ACTIVE")) is True
    assert server._is_active_connection(_ObjConn("ca_x", "INITIALIZING")) is False
    assert server._is_active_connection(_ObjConn(None, "ACTIVE")) is False
    assert server._is_active_connection(_ObjConn("", "ACTIVE")) is False


def test_is_active_connection_recognises_dict_shape():
    assert server._is_active_connection(_dict("ca_x", "ACTIVE")) is True
    assert server._is_active_connection(_dict("ca_x", "INITIALIZING")) is False
    for bad in ("EXPIRED", "FAILED", "DROPPED", "REVOKED", "PENDING"):
        assert server._is_active_connection(_dict("ca_x", bad)) is False, bad
    assert server._is_active_connection(_dict(None, "ACTIVE")) is False
    assert server._is_active_connection(_dict("", "ACTIVE")) is False
    assert server._is_active_connection({}) is False


def test_is_active_connection_treats_missing_status_as_active():
    """Composio's `statuses=["ACTIVE"]` filter sometimes omits `status` from
    the returned records entirely. Those must still count as active as long
    as they carry a real id (defensive fall-through)."""
    assert server._is_active_connection(_ObjConn("ca_x", None)) is True
    assert server._is_active_connection(_dict("ca_x")) is True


# ---------- Status endpoint — SDK-object shape ----------
@pytest.mark.parametrize("platform", PLATFORMS)
def test_status_object_shape_no_records(monkeypatch, platform):
    monkeypatch.setattr(server, "_composio_client", lambda: _FakeClient([]))
    tc = TestClient(server.app)
    r = tc.get(f"/api/social/{platform}/status", headers={"X-User-Id": "u1"})
    j = r.json()
    assert r.status_code == 200
    assert j["connected"] is False
    assert j["connection_id"] is None
    assert j["configured"] is True


@pytest.mark.parametrize("platform", PLATFORMS)
@pytest.mark.parametrize("bad_status", ["INITIALIZING", "EXPIRED", "FAILED", "DROPPED", "REVOKED"])
def test_status_object_shape_ignores_non_active(monkeypatch, platform, bad_status):
    fake = _FakeClient([_ObjConn("ca_probe", bad_status)])
    monkeypatch.setattr(server, "_composio_client", lambda: fake)
    tc = TestClient(server.app)
    r = tc.get(f"/api/social/{platform}/status", headers={"X-User-Id": "u1"})
    j = r.json()
    assert j["connected"] is False, f"{platform}/{bad_status} leaked as connected"
    assert j["connection_id"] is None


@pytest.mark.parametrize("platform", PLATFORMS)
def test_status_object_shape_ignores_idless_records(monkeypatch, platform):
    fake = _FakeClient([_ObjConn(None, "ACTIVE"), _ObjConn("", "ACTIVE")])
    monkeypatch.setattr(server, "_composio_client", lambda: fake)
    tc = TestClient(server.app)
    r = tc.get(f"/api/social/{platform}/status", headers={"X-User-Id": "u1"})
    j = r.json()
    assert j["connected"] is False
    assert j["connection_id"] is None


@pytest.mark.parametrize("platform", PLATFORMS)
def test_status_object_shape_reports_active(monkeypatch, platform):
    fake = _FakeClient([_ObjConn("ca_active_1", "ACTIVE")])
    monkeypatch.setattr(server, "_composio_client", lambda: fake)
    tc = TestClient(server.app)
    r = tc.get(f"/api/social/{platform}/status", headers={"X-User-Id": "u1"})
    j = r.json()
    assert j["connected"] is True
    assert j["connection_id"] == "ca_active_1"
    assert j["configured"] is True


# ---------- Status endpoint — dict shape ----------
@pytest.mark.parametrize("platform", PLATFORMS)
@pytest.mark.parametrize("bad_status", ["INITIALIZING", "EXPIRED", "FAILED", "DROPPED", "REVOKED"])
def test_status_dict_shape_ignores_non_active(monkeypatch, platform, bad_status):
    fake = _FakeClient([_dict("ca_probe", bad_status)])
    monkeypatch.setattr(server, "_composio_client", lambda: fake)
    tc = TestClient(server.app)
    r = tc.get(f"/api/social/{platform}/status", headers={"X-User-Id": "u1"})
    j = r.json()
    assert j["connected"] is False, f"{platform}/{bad_status} leaked as connected"
    assert j["connection_id"] is None


@pytest.mark.parametrize("platform", PLATFORMS)
def test_status_dict_shape_reports_active(monkeypatch, platform):
    fake = _FakeClient([_dict("ca_dict_active", "ACTIVE")])
    monkeypatch.setattr(server, "_composio_client", lambda: fake)
    tc = TestClient(server.app)
    r = tc.get(f"/api/social/{platform}/status", headers={"X-User-Id": "u1"})
    j = r.json()
    assert j["connected"] is True
    assert j["connection_id"] == "ca_dict_active"


# ---------- Status response-shape stability ----------
@pytest.mark.parametrize("platform", PLATFORMS)
def test_status_response_shape_stable(monkeypatch, platform):
    """Frontend expects {platform, connected, configured, connection_id}."""
    fake = _FakeClient([_ObjConn("ca_x", "ACTIVE")])
    monkeypatch.setattr(server, "_composio_client", lambda: fake)
    tc = TestClient(server.app)
    r = tc.get(f"/api/social/{platform}/status", headers={"X-User-Id": "u1"})
    j = r.json()
    for k in ("platform", "connected", "configured", "connection_id"):
        assert k in j, f"missing {k} in {j}"


# ---------- Accounts endpoint — filters ----------
@pytest.mark.parametrize("platform", PLATFORMS)
def test_accounts_object_shape_filters_out_non_active(monkeypatch, platform):
    fake = _FakeClient([
        _ObjConn("ca_ok", "ACTIVE"),
        _ObjConn("ca_init", "INITIALIZING"),
        _ObjConn("ca_dropped", "DROPPED"),
        _ObjConn(None, "ACTIVE"),
        _ObjConn("", "ACTIVE"),
    ])
    monkeypatch.setattr(server, "_composio_client", lambda: fake)
    tc = TestClient(server.app)
    r = tc.get(f"/api/social/{platform}/accounts", headers={"X-User-Id": "u1"})
    j = r.json()
    assert j["configured"] is True
    ids = [a["id"] for a in j["accounts"]]
    assert ids == ["ca_ok"], f"unexpected accounts on {platform}: {ids}"


@pytest.mark.parametrize("platform", PLATFORMS)
def test_accounts_dict_shape_filters_out_non_active(monkeypatch, platform):
    fake = _FakeClient([
        _dict("ca_ok", "ACTIVE"),
        _dict("ca_init", "INITIALIZING"),
        _dict("ca_expired", "EXPIRED"),
        _dict(None, "ACTIVE"),
    ])
    monkeypatch.setattr(server, "_composio_client", lambda: fake)
    tc = TestClient(server.app)
    r = tc.get(f"/api/social/{platform}/accounts", headers={"X-User-Id": "u1"})
    j = r.json()
    ids = [a["id"] for a in j["accounts"]]
    assert ids == ["ca_ok"], f"unexpected accounts on {platform}: {ids}"


@pytest.mark.parametrize("platform", PLATFORMS)
def test_accounts_preserves_active_records(monkeypatch, platform):
    """Multiple genuinely-active accounts must all still surface — this is
    the "preserve existing behaviour" contract."""
    fake = _FakeClient([
        _ObjConn("ca_1", "ACTIVE"),
        _ObjConn("ca_2", "ACTIVE"),
    ])
    monkeypatch.setattr(server, "_composio_client", lambda: fake)
    tc = TestClient(server.app)
    r = tc.get(f"/api/social/{platform}/accounts", headers={"X-User-Id": "u1"})
    j = r.json()
    ids = [a["id"] for a in j["accounts"]]
    assert set(ids) == {"ca_1", "ca_2"}


@pytest.mark.parametrize("platform", PLATFORMS)
def test_accounts_empty_for_probe_user(monkeypatch, platform):
    monkeypatch.setattr(server, "_composio_client", lambda: _FakeClient([]))
    tc = TestClient(server.app)
    r = tc.get(f"/api/social/{platform}/accounts", headers={"X-User-Id": "probe"})
    j = r.json()
    assert j["accounts"] == []
    assert j["configured"] is True
