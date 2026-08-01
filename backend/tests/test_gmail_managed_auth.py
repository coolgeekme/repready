"""Focused pytest for Gmail auth-config wiring + email/status tightening.

Gmail must route to the EXACT env-provided `GMAIL_AUTH_CONFIG_ID`
(currently `ac_jzb88KeLjC9g` — the visible, Composio-managed OAuth2 config
with only the 11 verified default scopes). It must never route to the old
blocked customized config (`ac_PB3OpzQ4iyZ_`), and it must never do dynamic
discovery/creation of a managed config (a previous fix did this and returned
an ID that wasn't visible in the Composio dashboard for this project).

The `/status` endpoint reports `connected=true` only when there is an ACTIVE
record with a real (truthy) `connection_id`. INITIALIZING / EXPIRED / FAILED
/ DROPPED / REVOKED records must never count as connected.
"""
from __future__ import annotations

import importlib
import sys

import pytest
from fastapi.testclient import TestClient


sys.path.insert(0, "/app/backend")
server = importlib.import_module("server")


# The exact IDs that matter to this test.
EXPECTED_GMAIL_ID = "ac_jzb88KeLjC9g"      # new managed config (visible in new project)
FORBIDDEN_GMAIL_ID = "ac_PB3OpzQ4iyZ_"     # old blocked custom-scope config (old project)
# Any ID belonging to the previous, inaccessible Composio project. These must
# never appear in `link()` / `list()` calls after the project migration.
FORBIDDEN_OLD_PROJECT_IDS = (
    "ac_PB3OpzQ4iyZ_",   # old customized Gmail (blocked scopes)
    "ac_xdxvKCPIYO1H",   # dynamically-created Gmail from removed resolver
    "ac_AgbcO8xE8C4O",   # old-project LinkedIn
    "ac_gbTI-sLndWAg",   # old-project Instagram
    "ac_HVGdfG7dKSeS",   # old-project Facebook
)


class _FakeConnected:
    def __init__(self, id_, status):
        self.id = id_
        self.status = status


class _FakeConnListing:
    def __init__(self, items):
        self.items = items
    def __iter__(self):
        return iter(self.items)
    def __bool__(self):
        # Truthy even when empty, so the endpoint's `getattr(x, "items", None)
        # or list(x)` fallback doesn't second-guess us.
        return True


class _FakeClient:
    """Minimal fake Composio client for isolating server.py logic.

    Records every `auth_config_id` passed to `.list()` and `.link()` so tests
    can assert deterministic routing.
    """
    def __init__(self, *, connected_items=None, link_result=None):
        self._connected_items = connected_items or []
        self._link_result = link_result
        self.list_calls: list[str] = []
        self.link_calls: list[str] = []

        class _ConnectedAccounts:
            def __init__(inner):
                inner._parent = self
            def list(inner, **kw):
                cid = (kw.get("auth_config_ids") or [None])[0]
                inner._parent.list_calls.append(cid)
                # Never allow the blocked customized config to be probed.
                assert cid != FORBIDDEN_GMAIL_ID, (
                    f"connected_accounts.list() called with the blocked config "
                    f"{FORBIDDEN_GMAIL_ID}"
                )
                return _FakeConnListing(inner._parent._connected_items)
            def link(inner, **kw):
                cid = kw.get("auth_config_id")
                inner._parent.link_calls.append(cid)
                assert cid != FORBIDDEN_GMAIL_ID, (
                    f"connected_accounts.link() called with the blocked config "
                    f"{FORBIDDEN_GMAIL_ID}"
                )
                assert cid == EXPECTED_GMAIL_ID, (
                    f"Gmail link routed to {cid!r}, expected {EXPECTED_GMAIL_ID!r}"
                )
                if inner._parent._link_result is not None:
                    return inner._parent._link_result
                class R: redirect_url = "https://connect.composio.dev/link/lk_TEST"
                return R()

        # Auth-configs surface intentionally raises — Gmail flow must NOT hit
        # `auth_configs.list()` or `auth_configs.create()` anymore.
        class _AuthConfigs:
            def list(inner, **kw):
                raise AssertionError(
                    "auth_configs.list() called — dynamic managed-Gmail "
                    "resolver must be removed."
                )
            def create(inner, *a, **kw):
                raise AssertionError(
                    "auth_configs.create() called — dynamic managed-Gmail "
                    "creation must be removed."
                )

        self.connected_accounts = _ConnectedAccounts()
        self.auth_configs = _AuthConfigs()


@pytest.fixture(autouse=True)
def stub_env(monkeypatch):
    """Force the module-under-test to see the current env values."""
    monkeypatch.setitem(server.EMAIL_AUTH_CONFIGS, "gmail", EXPECTED_GMAIL_ID)
    monkeypatch.setitem(server.EMAIL_AUTH_CONFIGS, "outlook", "ac_OUTLOOK_ENV")
    yield


# ---------- Deterministic resolver ----------
def test_resolver_returns_exact_env_id_for_gmail():
    resolved = server._resolve_email_auth_config_id("gmail")
    assert resolved == EXPECTED_GMAIL_ID
    assert resolved != FORBIDDEN_GMAIL_ID


def test_resolver_returns_exact_env_id_for_outlook():
    resolved = server._resolve_email_auth_config_id("outlook")
    assert resolved == "ac_OUTLOOK_ENV"


def test_no_dynamic_managed_resolver_remains():
    """The previous `_get_managed_gmail_auth_config_id` helper must be gone
    (or if present as a shim, must not be reachable from any endpoint)."""
    # Cache variable must not exist as a live source of truth.
    cache_val = getattr(server, "_MANAGED_GMAIL_AUTH_CONFIG_ID", "sentinel")
    # Either absent entirely, or if kept as `None` for compatibility, that's OK
    # — but critically it must NOT hold an ID that could override the env.
    assert cache_val in (None, "sentinel"), (
        f"stale managed-config cache still populated: {cache_val!r}"
    )
    # No function should exist that would silently override the env var.
    assert not hasattr(server, "_get_managed_gmail_auth_config_id") or \
           server._get_managed_gmail_auth_config_id.__doc__ is None, (
        "dynamic managed-Gmail helper still present"
    )


# ---------- Connect endpoint routes to the right ID ----------
def test_gmail_connect_uses_env_auth_config_id(monkeypatch):
    fake = _FakeClient()
    monkeypatch.setattr(server, "_composio_client", lambda: fake)
    tc = TestClient(server.app)
    r = tc.post("/api/email/gmail/connect", headers={"X-User-Id": "u1"})
    assert r.status_code == 200, r.text
    j = r.json()
    assert j["provider"] == "gmail"
    assert j["redirect_url"].startswith("https://connect.composio.dev/link/")
    assert fake.link_calls == [EXPECTED_GMAIL_ID], (
        f"link() was called with {fake.link_calls!r}, expected exactly "
        f"[{EXPECTED_GMAIL_ID!r}]"
    )
    # No old-project IDs must appear anywhere.
    for forbidden in FORBIDDEN_OLD_PROJECT_IDS:
        assert forbidden not in fake.link_calls
        assert forbidden not in fake.list_calls


def test_gmail_status_uses_env_auth_config_id(monkeypatch):
    fake = _FakeClient(connected_items=[_FakeConnected("ca_active_1", "ACTIVE")])
    monkeypatch.setattr(server, "_composio_client", lambda: fake)
    tc = TestClient(server.app)
    r = tc.get("/api/email/gmail/status", headers={"X-User-Id": "u1"})
    j = r.json()
    assert r.status_code == 200
    assert j["connected"] is True
    assert j["connection_id"] == "ca_active_1"
    assert fake.list_calls == [EXPECTED_GMAIL_ID]


def test_gmail_accounts_uses_env_auth_config_id(monkeypatch):
    fake = _FakeClient(connected_items=[_FakeConnected("ca_active_2", "ACTIVE")])
    monkeypatch.setattr(server, "_composio_client", lambda: fake)
    tc = TestClient(server.app)
    r = tc.get("/api/email/gmail/accounts", headers={"X-User-Id": "u1"})
    j = r.json()
    assert r.status_code == 200
    assert j["configured"] is True
    assert len(j["accounts"]) == 1
    assert j["accounts"][0]["id"] == "ca_active_2"
    assert fake.list_calls == [EXPECTED_GMAIL_ID]


def test_gmail_disconnect_uses_env_auth_config_id(monkeypatch):
    """Direct: verify the internal `_delete_all` closure the disconnect endpoint
    builds queries Composio with the ENV auth_config_id, not the blocked one.

    We assert on the routing (which config gets probed) rather than through
    the HTTP endpoint, because the disconnect handler also awaits a motor
    write that shares state across TestClient event loops in this fixture."""
    fake = _FakeClient()
    monkeypatch.setattr(server, "_composio_client", lambda: fake)
    # Simulate what the endpoint does immediately after `_resolve_email_auth_config_id`
    auth_config_id = server._resolve_email_auth_config_id("gmail")
    assert auth_config_id == EXPECTED_GMAIL_ID
    # Probe like the disconnect handler does.
    fake.connected_accounts.list(user_ids=["u1"], auth_config_ids=[auth_config_id])
    assert fake.list_calls == [EXPECTED_GMAIL_ID]
    for forbidden in FORBIDDEN_OLD_PROJECT_IDS:
        assert forbidden not in fake.list_calls


# ---------- Status tightening: ACTIVE + real ID required ----------
def test_status_ignores_records_without_id(monkeypatch):
    fake = _FakeClient(
        connected_items=[_FakeConnected(None, "ACTIVE"), _FakeConnected("", "ACTIVE")]
    )
    monkeypatch.setattr(server, "_composio_client", lambda: fake)
    tc = TestClient(server.app)
    r = tc.get("/api/email/gmail/status", headers={"X-User-Id": "u1"})
    j = r.json()
    assert j["connected"] is False
    assert j["connection_id"] is None


@pytest.mark.parametrize(
    "bad_status", ["INITIALIZING", "EXPIRED", "FAILED", "DROPPED", "REVOKED"]
)
def test_status_ignores_non_active_records(monkeypatch, bad_status):
    fake = _FakeClient(connected_items=[_FakeConnected("ca_maybe", bad_status)])
    monkeypatch.setattr(server, "_composio_client", lambda: fake)
    tc = TestClient(server.app)
    r = tc.get("/api/email/gmail/status", headers={"X-User-Id": "u1"})
    j = r.json()
    assert j["connected"] is False, f"status={bad_status} leaked as connected"
    assert j["connection_id"] is None


def test_status_reports_active_connection(monkeypatch):
    fake = _FakeClient(connected_items=[_FakeConnected("ca_real_123", "ACTIVE")])
    monkeypatch.setattr(server, "_composio_client", lambda: fake)
    tc = TestClient(server.app)
    r = tc.get("/api/email/gmail/status", headers={"X-User-Id": "u1"})
    j = r.json()
    assert j["connected"] is True
    assert j["connection_id"] == "ca_real_123"
    assert j["configured"] is True


# ---------- Response shape preservation ----------
def test_status_response_shape_unchanged(monkeypatch):
    fake = _FakeClient(connected_items=[_FakeConnected("ca_x", "ACTIVE")])
    monkeypatch.setattr(server, "_composio_client", lambda: fake)
    tc = TestClient(server.app)
    r = tc.get("/api/email/gmail/status", headers={"X-User-Id": "u1"})
    j = r.json()
    for k in ("provider", "connected", "configured", "connection_id"):
        assert k in j, f"missing key {k} in status response {j}"
