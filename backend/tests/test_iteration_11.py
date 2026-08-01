"""Iteration 11 backend verification.

Tests the following server.py fixes:
  1. POST /api/social/{platform}/connect -> always fresh redirect_url, no `already_connected`.
  2. POST /api/social/{platform}/post -> HTTP 409 with friendly detail when no linked account.
  3. Explicit connection_id / page_id override bypasses 409 (fake ids -> 200 with success:false).
  4. _linkedin_get_author_urn caches PER connected_account_id (not user-wide).
  5. Disconnect clears both legacy `linkedin_author_urn` and new `linkedin_author_urns`.
  6. Regressions: /social/all-accounts, /legal/privacy, PATCH /history/{id}.
  7. app.json version bumps (1.0.7, ios 108, android 108).
"""
import asyncio
import json
import os
import sys
import uuid
from pathlib import Path

import pytest
import requests
from pymongo import MongoClient

# Make backend importable so we can call helpers directly.
sys.path.insert(0, "/app/backend")

BASE_URL = "http://localhost:8001"
MONGO_URL = os.environ.get("MONGO_URL", "mongodb://localhost:27017")
DB_NAME = os.environ.get("DB_NAME", "repready_db")


def _hdr(uid: str):
    return {"X-User-Id": uid, "Content-Type": "application/json"}


@pytest.fixture(scope="module")
def mongo():
    c = MongoClient(MONGO_URL)
    yield c[DB_NAME]
    c.close()


@pytest.fixture()
def fresh_uid(mongo):
    uid = f"it11-{uuid.uuid4().hex[:10]}"
    yield uid
    # cleanup
    try:
        mongo.users.delete_many({"user_id": uid})
        mongo.companies.delete_many({"user_id": uid})
        mongo.history.delete_many({"user_id": uid})
    except Exception:
        pass


# ---------------------- 1. connect always yields fresh redirect_url ---------------------
class TestConnectRedirect:
    def test_connect_linkedin_first_call(self, fresh_uid):
        r = requests.post(
            f"{BASE_URL}/api/social/linkedin/connect",
            headers=_hdr(fresh_uid),
            json={},
            timeout=30,
        )
        assert r.status_code == 200, f"Expected 200, got {r.status_code}: {r.text[:300]}"
        body = r.json()
        assert "already_connected" not in body, f"Should NOT return already_connected: {body}"
        assert body.get("platform") == "linkedin"
        redir = body.get("redirect_url") or ""
        assert redir.startswith("https://"), f"redirect_url not https: {redir!r}"
        assert "connect.composio" in redir or "composio" in redir, f"unexpected redirect host: {redir}"

    def test_connect_linkedin_second_call_still_fresh(self, fresh_uid):
        r1 = requests.post(
            f"{BASE_URL}/api/social/linkedin/connect", headers=_hdr(fresh_uid), json={}, timeout=30
        )
        assert r1.status_code == 200, r1.text[:300]
        url1 = r1.json().get("redirect_url")

        r2 = requests.post(
            f"{BASE_URL}/api/social/linkedin/connect", headers=_hdr(fresh_uid), json={}, timeout=30
        )
        assert r2.status_code == 200, f"Second call not 200: {r2.status_code} / {r2.text[:300]}"
        body2 = r2.json()
        assert "already_connected" not in body2, f"Second call should NOT short-circuit: {body2}"
        url2 = body2.get("redirect_url") or ""
        assert url2.startswith("https://")
        # Composio should mint a NEW link id each time (allow_multiple=True).
        assert url1 and url2 and url1 != url2, f"Redirect URLs should differ. url1={url1} url2={url2}"

    def test_connect_unknown_platform(self, fresh_uid):
        r = requests.post(
            f"{BASE_URL}/api/social/nosuchplatform/connect",
            headers=_hdr(fresh_uid),
            json={},
            timeout=10,
        )
        assert r.status_code == 404, f"Expected 404, got {r.status_code}: {r.text[:200]}"


# ---------------------- 2. post without linked account -> 409 ---------------------------
class TestPostRequiresLinkedAccount:
    def test_linkedin_post_no_account_returns_409(self, fresh_uid):
        r = requests.post(
            f"{BASE_URL}/api/social/linkedin/post",
            headers=_hdr(fresh_uid),
            json={"content": "hi"},
            timeout=15,
        )
        assert r.status_code == 409, f"Expected 409, got {r.status_code}: {r.text[:400]}"
        detail = (r.json().get("detail") or "").lower()
        assert "no linkedin account is linked" in detail, f"Unexpected detail: {detail}"

    def test_facebook_post_no_account_returns_409(self, fresh_uid):
        r = requests.post(
            f"{BASE_URL}/api/social/facebook/post",
            headers=_hdr(fresh_uid),
            json={"content": "hi"},
            timeout=15,
        )
        assert r.status_code == 409, f"Expected 409, got {r.status_code}: {r.text[:400]}"
        detail = (r.json().get("detail") or "").lower()
        assert "no facebook account is linked" in detail, f"Unexpected detail: {detail}"

    def test_instagram_post_no_account_returns_409(self, fresh_uid):
        # Instagram requires an image; supply a tiny 1x1 PNG base64.
        tiny_png = (
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
        )
        r = requests.post(
            f"{BASE_URL}/api/social/instagram/post",
            headers=_hdr(fresh_uid),
            json={"content": "hi", "image_b64": tiny_png, "image_mime": "image/png"},
            timeout=20,
        )
        assert r.status_code == 409, f"Expected 409, got {r.status_code}: {r.text[:400]}"
        detail = (r.json().get("detail") or "").lower()
        assert "no instagram account is linked" in detail, f"Unexpected detail: {detail}"


# ---------------------- 3. explicit override bypasses 409 --------------------------------
class TestOverrideBypasses409:
    def test_linkedin_with_fake_connection_id_bypasses(self, fresh_uid):
        r = requests.post(
            f"{BASE_URL}/api/social/linkedin/post",
            headers=_hdr(fresh_uid),
            json={"content": "hi", "connection_id": "ca_fake_nonexistent"},
            timeout=30,
        )
        # MUST NOT be a 409 (i.e. must not be blocked by the active-company check).
        assert r.status_code != 409, f"Override should bypass 409, got 409: {r.text[:400]}"
        # Should return 200 with success:false (Composio will error on the fake conn).
        assert r.status_code == 200, f"Expected 200, got {r.status_code}: {r.text[:400]}"
        body = r.json()
        assert body.get("success") is False, f"Expected success:false, got {body}"
        assert "error" in body and body["error"], f"Should include error msg: {body}"

    def test_facebook_with_fake_page_id_bypasses(self, fresh_uid):
        r = requests.post(
            f"{BASE_URL}/api/social/facebook/post",
            headers=_hdr(fresh_uid),
            json={"content": "hi", "page_id": "fake_page_1234"},
            timeout=30,
        )
        assert r.status_code != 409, f"Override should bypass 409, got 409: {r.text[:400]}"
        assert r.status_code == 200, f"Expected 200, got {r.status_code}: {r.text[:400]}"
        body = r.json()
        assert body.get("success") is False, f"Expected success:false, got {body}"


# ---------------------- 4. LinkedIn URN cache is per-connection ---------------------------
class TestLinkedInUrnCachePerConnection:
    def test_cache_hits_by_connection(self, mongo):
        from server import _linkedin_get_author_urn

        uid = f"it11-cache-{uuid.uuid4().hex[:8]}"
        try:
            mongo.users.insert_one({
                "user_id": uid,
                "linkedin_author_urns": {
                    "conn_A": "urn:li:person:A",
                    "conn_B": "urn:li:person:B",
                },
            })

            async def _both():
                a = await _linkedin_get_author_urn(uid, connected_account_id="conn_A")
                b = await _linkedin_get_author_urn(uid, connected_account_id="conn_B")
                return a, b
            urn_a, urn_b = asyncio.run(_both())
            assert urn_a == "urn:li:person:A", f"Expected urn:li:person:A, got {urn_a}"
            assert urn_b == "urn:li:person:B", f"Expected urn:li:person:B, got {urn_b}"

            # Confirm the legacy singular field is NOT read by the cache path.
            doc = mongo.users.find_one({"user_id": uid}) or {}
            # It should not have been created / used.
            assert "linkedin_author_urn" not in doc or doc.get("linkedin_author_urn") in (None, ""), \
                f"Legacy field should not be used: {doc.get('linkedin_author_urn')!r}"
        finally:
            mongo.users.delete_one({"user_id": uid})

    def test_default_bucket_falls_through_to_composio(self, mongo):
        """Without a connected_account_id, the code uses the '_default' bucket. Without a
        real Composio connection this will raise / return an error — that's fine, we just
        assert it does NOT return one of the seeded per-connection URNs.
        """
        from server import _linkedin_get_author_urn

        uid = f"it11-cache-def-{uuid.uuid4().hex[:8]}"
        try:
            mongo.users.insert_one({
                "user_id": uid,
                "linkedin_author_urns": {"conn_A": "urn:li:person:A"},
            })
            got_urn = None
            errored = False
            try:
                got_urn = asyncio.run(_linkedin_get_author_urn(uid, connected_account_id=None))
            except Exception:
                errored = True
            # Should either error (no real connection) OR return something that is NOT conn_A's URN
            assert errored or got_urn != "urn:li:person:A", \
                f"Default bucket must not reuse per-connection URN, got {got_urn!r}"
        finally:
            mongo.users.delete_one({"user_id": uid})


# ---------------------- 5. Disconnect clears BOTH legacy + new cache -------------------
class TestDisconnectClearsBothCaches:
    def test_disconnect_linkedin_unsets_both_fields(self, mongo, fresh_uid):
        # Seed both legacy + new cache fields.
        mongo.users.update_one(
            {"user_id": fresh_uid},
            {"$set": {
                "user_id": fresh_uid,
                "linkedin_author_urn": "urn:li:person:OLDCACHE",
                "linkedin_author_urns": {"c1": "urn:li:person:NEWCACHE"},
                "linkedin_connection_id": "ca_stale",
                "linkedin_connected": True,
            }},
            upsert=True,
        )

        r = requests.post(
            f"{BASE_URL}/api/social/linkedin/disconnect",
            headers=_hdr(fresh_uid),
            timeout=30,
        )
        assert r.status_code == 200, f"Disconnect failed: {r.status_code} {r.text[:200]}"

        doc = mongo.users.find_one({"user_id": fresh_uid}) or {}
        assert "linkedin_author_urn" not in doc, f"Legacy field NOT cleared: {doc.get('linkedin_author_urn')!r}"
        assert "linkedin_author_urns" not in doc, f"New map NOT cleared: {doc.get('linkedin_author_urns')!r}"
        assert "linkedin_connection_id" not in doc, f"linkedin_connection_id NOT cleared"
        assert "linkedin_connected" not in doc, f"linkedin_connected NOT cleared"


# ---------------------- 6. Regressions --------------------------------------------------
class TestRegressions:
    def test_all_accounts_still_200(self, fresh_uid):
        r = requests.get(
            f"{BASE_URL}/api/social/all-accounts", headers=_hdr(fresh_uid), timeout=15
        )
        assert r.status_code == 200, f"{r.status_code} {r.text[:200]}"
        body = r.json()
        assert "linkedin" in body and "facebook_pages" in body and "instagram" in body, body

    def test_privacy_still_200_html(self):
        r = requests.get(f"{BASE_URL}/api/legal/privacy", timeout=10)
        assert r.status_code == 200, f"{r.status_code} {r.text[:200]}"
        ct = r.headers.get("content-type", "").lower()
        assert "text/html" in ct, f"Expected text/html, got {ct}"

    def test_patch_history_whitelisted_field(self, mongo, fresh_uid):
        # Seed a history doc
        hid = f"h-{uuid.uuid4().hex[:8]}"
        mongo.history.insert_one({
            "id": hid, "user_id": fresh_uid, "title": "orig", "saved": False,
        })
        r = requests.patch(
            f"{BASE_URL}/api/history/{hid}",
            headers=_hdr(fresh_uid),
            json={"title": "updated title"},
            timeout=10,
        )
        assert r.status_code == 200, f"{r.status_code} {r.text[:200]}"
        body = r.json()
        assert body.get("title") == "updated title", body
        # ObjectId should not leak
        assert "_id" not in body, f"Mongo _id leaked: {body}"


# ---------------------- 7. Version bumps -------------------------------------------------
class TestVersionBumps:
    def test_app_json_version(self):
        p = Path("/app/frontend/app.json")
        data = json.loads(p.read_text())
        expo = data["expo"]
        assert expo["version"] == "1.0.7", f"version={expo['version']}"
        assert expo["ios"]["buildNumber"] == "108", f"ios.buildNumber={expo['ios']['buildNumber']}"
        assert expo["android"]["versionCode"] == 108, f"android.versionCode={expo['android']['versionCode']}"
