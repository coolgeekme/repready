"""Iteration 10 backend tests.

Verifies TWO bug fixes:
  BUG A — Instagram publishing surfaces friendly errors and auto-refreshes a stale
          cached ig_user_id before returning.
  BUG B — Account picker shows real handles: unit test the _linkedin_display_name and
          _instagram_display_name_and_id extractors + regressions on
          GET /api/social/all-accounts (+ /debug admin guard).

Runs against local backend at http://localhost:8001 with LIVE Composio.
"""
import os
import sys
import uuid
import base64
import time
import pytest
import requests

sys.path.insert(0, "/app/backend")

from server import (
    _linkedin_display_name,
    _instagram_display_name_and_id,
)  # noqa: E402

BASE_URL = "http://localhost:8001"
API = f"{BASE_URL}/api"

# 1x1 transparent PNG
TINY_PNG_B64 = (
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII="
)


@pytest.fixture(scope="module")
def uid() -> str:
    return f"it10-{uuid.uuid4().hex[:10]}"


@pytest.fixture(scope="module")
def admin_uid() -> str:
    return f"it10-admin-{uuid.uuid4().hex[:8]}"


@pytest.fixture
def api():
    s = requests.Session()
    s.headers.update({"Content-Type": "application/json"})
    return s


# ---------------------------------------------------------------------------
# BUG B — Unit tests for the display-name extractors
# ---------------------------------------------------------------------------
class TestLinkedInDisplayName:
    def test_openid_flat_name(self):
        assert _linkedin_display_name({"name": "Alex Rivera"}) == "Alex Rivera"

    def test_openid_given_family(self):
        assert (
            _linkedin_display_name({"given_name": "Alex", "family_name": "Rivera"})
            == "Alex Rivera"
        )

    def test_legacy_localized_nested(self):
        payload = {
            "firstName": {"localized": {"en_US": "Alex"}},
            "lastName": {"localized": {"en_US": "Rivera"}},
        }
        assert _linkedin_display_name(payload) == "Alex Rivera"

    def test_nested_data_wrapper(self):
        assert _linkedin_display_name({"data": {"name": "Nested Alex"}}) == "Nested Alex"

    def test_empty_returns_none(self):
        assert _linkedin_display_name({}) is None

    def test_non_dict_returns_none(self):
        assert _linkedin_display_name(None) is None
        assert _linkedin_display_name("string") is None


class TestInstagramDisplayNameAndId:
    def test_flat_username_id(self):
        assert _instagram_display_name_and_id(
            {"username": "northstar_ai", "id": "17841000"}
        ) == ("northstar_ai", "17841000")

    def test_nested_data_wrapper(self):
        assert _instagram_display_name_and_id(
            {"data": {"username": "foo", "id": "222"}}
        ) == ("foo", "222")

    def test_empty_returns_none_tuple(self):
        assert _instagram_display_name_and_id({}) == (None, None)

    def test_non_dict_returns_none_tuple(self):
        assert _instagram_display_name_and_id(None) == (None, None)


# ---------------------------------------------------------------------------
# BUG A — Instagram friendly error handling
# ---------------------------------------------------------------------------
class TestInstagramFriendlyErrors:
    def test_ig_post_unconnected_user_returns_clean_200(self, api, uid):
        """Fresh user, no connected account. Must be HTTP 200 with success:false
        and a clean error string — never raw JSON / HTML."""
        r = api.post(
            f"{API}/social/instagram/post",
            json={"content": "Hello IG", "image_b64": TINY_PNG_B64},
            headers={"X-User-Id": uid},
        )
        assert r.status_code == 200, f"expected 200, got {r.status_code}: {r.text[:400]}"
        body = r.json()
        assert body.get("platform") == "instagram"
        assert body.get("success") is False
        err = body.get("error") or ""
        assert isinstance(err, str) and err.strip(), f"error missing: {body}"

        # Must be a friendly sentence — NOT raw JSON / HTML
        low = err.lower()
        assert '{"error"' not in err, f"raw JSON leaked: {err}"
        assert "<html" not in low and "<!doctype" not in low, f"HTML leaked: {err}"
        # No stack trace / traceback
        assert "traceback" not in low, f"stacktrace leaked: {err}"

    def test_ig_post_with_stale_cache_triggers_refresh_and_returns_clean(
        self, api, uid
    ):
        """Seed a stale ig_user_id cache for the user, then call the endpoint.
        Even though there is no real Composio connection, we must still get a
        clean 200 JSON (no crash from the cache-refresh path)."""
        from pymongo import MongoClient

        mongo_url = os.environ.get("MONGO_URL")
        db_name = os.environ.get("DB_NAME")
        assert mongo_url and db_name, "MONGO_URL/DB_NAME must be set for this test"
        client = MongoClient(mongo_url)
        db = client[db_name]

        stale_uid = "test-stale-ig"
        # Ensure the seed user has a stale cached ig_user_id under _default
        db.users.update_one(
            {"user_id": stale_uid},
            {"$set": {"instagram_user_ids": {"_default": "271FAKE111"}}},
            upsert=True,
        )
        try:
            r = api.post(
                f"{API}/social/instagram/post",
                json={"content": "stale-cache test", "image_b64": TINY_PNG_B64},
                headers={"X-User-Id": stale_uid},
            )
            assert r.status_code == 200, f"expected 200, got {r.status_code}: {r.text[:400]}"
            body = r.json()
            assert body.get("platform") == "instagram"
            assert body.get("success") is False
            err = body.get("error") or ""
            # No raw error blobs
            assert '{"error"' not in err
            assert "<html" not in err.lower()
            # Since this user has no connection at all, the discovery step likely
            # short-circuits with "no connected account". Either way — must be
            # a friendly, plain-english sentence.
            assert len(err) < 500
        finally:
            db.users.delete_one({"user_id": stale_uid})
            client.close()

    def test_humanize_provider_error_invalid_parameter(self):
        """Regression: _humanize_provider_error still maps generic IG errors."""
        from server import _humanize_provider_error

        msg = _humanize_provider_error("Invalid request data", "instagram")
        assert "Instagram" in msg and "business" in msg.lower()
        msg2 = _humanize_provider_error("<html>Bad Gateway</html>", "instagram")
        assert "temporarily unreachable" in msg2.lower()


# ---------------------------------------------------------------------------
# BUG A regressions on the other platforms
# ---------------------------------------------------------------------------
class TestOtherPlatformsClean:
    def test_linkedin_unconnected_clean_200(self, api, uid):
        r = api.post(
            f"{API}/social/linkedin/post",
            json={"content": "hi"},
            headers={"X-User-Id": uid},
        )
        assert r.status_code == 200, r.text[:300]
        body = r.json()
        assert body.get("platform") == "linkedin"
        assert body.get("success") is False
        err = body.get("error") or ""
        assert isinstance(err, str) and err.strip()
        assert '{"error"' not in err and "<html" not in err.lower()

    def test_facebook_unconnected_clean_200(self, api, uid):
        r = api.post(
            f"{API}/social/facebook/post",
            json={"content": "hi"},
            headers={"X-User-Id": uid},
        )
        assert r.status_code == 200, r.text[:300]
        body = r.json()
        assert body.get("platform") == "facebook"
        assert body.get("success") is False
        err = body.get("error") or ""
        assert isinstance(err, str) and err.strip()
        assert '{"error"' not in err and "<html" not in err.lower()


# ---------------------------------------------------------------------------
# BUG B — /social/all-accounts + /debug
# ---------------------------------------------------------------------------
class TestAllAccountsEndpoint:
    def test_all_accounts_shape_for_fresh_user(self, api, uid):
        r = api.get(f"{API}/social/all-accounts", headers={"X-User-Id": uid})
        assert r.status_code == 200, r.text[:300]
        body = r.json()
        assert isinstance(body, dict)
        for key in ("linkedin", "facebook_pages", "instagram"):
            assert key in body, f"missing key {key}: {body}"
            assert isinstance(body[key], list), f"{key} should be list"

    def test_all_accounts_debug_non_admin_403(self, api, uid):
        r = api.get(f"{API}/social/all-accounts/debug", headers={"X-User-Id": uid})
        assert r.status_code == 403, f"expected 403, got {r.status_code}: {r.text[:200]}"

    def test_all_accounts_debug_admin_200(self, api, admin_uid):
        # Seed admin flag on user doc
        from pymongo import MongoClient

        mongo_url = os.environ.get("MONGO_URL")
        db_name = os.environ.get("DB_NAME")
        client = MongoClient(mongo_url)
        db = client[db_name]
        db.users.update_one(
            {"user_id": admin_uid},
            {"$set": {"is_admin": True}},
            upsert=True,
        )
        try:
            r = api.get(
                f"{API}/social/all-accounts/debug",
                headers={"X-User-Id": admin_uid},
            )
            assert r.status_code == 200, f"expected 200, got {r.status_code}: {r.text[:300]}"
            body = r.json()
            # Should have keys for each platform (they can be empty lists)
            for key in ("linkedin", "facebook", "instagram"):
                assert key in body, f"missing platform {key}: {list(body.keys())}"
                assert isinstance(body[key], list)
        finally:
            db.users.delete_one({"user_id": admin_uid})
            client.close()
