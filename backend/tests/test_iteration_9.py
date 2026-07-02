"""Iteration 9 backend tests: image persistence on history + per-post social account picker.

Runs against local backend (fastest). Composio is hit LIVE — we only test the "no
connections" path so success:false responses are expected & considered pass.
"""
import os
import uuid
import time
from datetime import datetime, timezone, timedelta

import pytest
import requests

BASE_URL = os.environ.get("BACKEND_TEST_URL", "http://localhost:8001")


@pytest.fixture(scope="module")
def user_id():
    # Fresh isolated user for the whole module
    return f"it9-{uuid.uuid4().hex[:12]}"


@pytest.fixture(scope="module")
def api(user_id):
    s = requests.Session()
    s.headers.update({"Content-Type": "application/json", "X-User-Id": user_id})
    return s


@pytest.fixture(scope="module")
def anon():
    s = requests.Session()
    s.headers.update({"Content-Type": "application/json"})
    return s


# ------------------------- FEATURE A: History ------------------------- #

class TestHistoryAuth:
    def test_get_history_item_requires_auth(self, anon):
        r = anon.get(f"{BASE_URL}/api/history/anything")
        assert r.status_code == 401, r.text

    def test_patch_history_item_requires_auth(self, anon):
        r = anon.patch(f"{BASE_URL}/api/history/anything", json={"saved": True})
        assert r.status_code == 401, r.text


@pytest.fixture(scope="module")
def history_id(api):
    """Create a cold-email history entry (uses live LLM). Skip module if LLM flakes."""
    payload = {
        "company_name": "TEST_Iteration9 Corp",
        "contact_name": "Alex",
        "contact_title": "Head of Ops",
        "product_pitch": "faster onboarding",
        "tone": "professional",
    }
    r = api.post(f"{BASE_URL}/api/generate/cold-email", json=payload, timeout=90)
    if r.status_code != 200:
        pytest.skip(f"LLM cold-email seed failed: {r.status_code} {r.text[:200]}")
    data = r.json()
    hid = data.get("id")
    assert hid, f"no id in response: {data}"
    return hid


class TestHistoryDetail:
    def test_detail_returns_entry_no_images_initially(self, api, history_id):
        r = api.get(f"{BASE_URL}/api/history/{history_id}")
        assert r.status_code == 200, r.text
        doc = r.json()
        assert doc["id"] == history_id
        # `images` should be absent or null/empty initially
        imgs = doc.get("images")
        assert imgs in (None, {}, [], ), f"expected no images, got: {imgs!r}"

    def test_list_excludes_images_field(self, api, history_id):
        r = api.get(f"{BASE_URL}/api/history")
        assert r.status_code == 200, r.text
        items = r.json().get("items", [])
        assert any(it["id"] == history_id for it in items)
        for it in items:
            assert "images" not in it, f"list must exclude images; found in {it['id']}"


class TestPostImagePersistence:
    def test_post_image_saves_to_history(self, api, history_id):
        r = api.post(
            f"{BASE_URL}/api/generate/post-image",
            json={
                "hook": "Onboarding in a day",
                "body": "How we compress a month of setup into 24 hours.",
                "history_id": history_id,
                "variant_index": 0,
            },
            timeout=120,
        )
        # 200 with base64 OR 502 (Gemini blip) both allowed by spec
        assert r.status_code in (200, 502), r.text
        if r.status_code != 200:
            pytest.skip(f"Gemini not available this run: {r.text[:200]}")
        body = r.json()
        assert body.get("data"), "image data missing"
        assert body.get("history_id") == history_id
        assert body.get("variant_index") == 0

        # Verify persisted onto history doc
        r2 = api.get(f"{BASE_URL}/api/history/{history_id}")
        assert r2.status_code == 200
        doc = r2.json()
        images = doc.get("images") or {}
        # Mongo dotted keys => images should be a dict with "0"
        assert "0" in images, f"images.0 missing; got keys={list(images)}"
        assert images["0"].get("data"), "images.0.data missing"
        assert images["0"].get("mime")
        assert images["0"].get("prompt")
        assert images["0"].get("created_at")


class TestHistoryPatch:
    def test_patch_selected_accounts(self, api, history_id):
        r = api.patch(
            f"{BASE_URL}/api/history/{history_id}",
            json={"selected_accounts": {"linkedin": "conn_abc"}},
        )
        assert r.status_code == 200, r.text
        doc = r.json()
        assert doc.get("selected_accounts", {}).get("linkedin") == "conn_abc"

        # Confirm persisted via GET
        r2 = api.get(f"{BASE_URL}/api/history/{history_id}")
        assert r2.status_code == 200
        assert r2.json().get("selected_accounts", {}).get("linkedin") == "conn_abc"

    def test_patch_rejects_unknown_field(self, api, history_id):
        r = api.patch(
            f"{BASE_URL}/api/history/{history_id}",
            json={"unknown_field": "x"},
        )
        assert r.status_code == 400, r.text

    def test_patch_unknown_id_returns_404(self, api):
        r = api.patch(
            f"{BASE_URL}/api/history/{uuid.uuid4()}",
            json={"saved": True},
        )
        assert r.status_code == 404, r.text


# ------------------------- FEATURE B: Social picker ------------------------- #

class TestSocialAllAccounts:
    def test_returns_empty_shape_for_fresh_user(self, api):
        r = api.get(f"{BASE_URL}/api/social/all-accounts", timeout=60)
        assert r.status_code == 200, r.text
        body = r.json()
        assert set(body.keys()) >= {"linkedin", "facebook_pages", "instagram"}
        assert body["linkedin"] == []
        assert body["facebook_pages"] == []
        assert body["instagram"] == []


class TestSocialPostOverrides:
    def test_linkedin_post_with_nonexistent_connection(self, api):
        r = api.post(
            f"{BASE_URL}/api/social/linkedin/post",
            json={"content": "hi", "connection_id": "does-not-exist"},
            timeout=60,
        )
        assert r.status_code == 200, r.text
        body = r.json()
        assert body.get("success") is False
        assert body.get("error"), "friendly error string missing"

    def test_facebook_post_with_page_override(self, api):
        r = api.post(
            f"{BASE_URL}/api/social/facebook/post",
            json={"content": "hi", "page_id": "12345"},
            timeout=60,
        )
        assert r.status_code == 200, r.text
        body = r.json()
        assert body.get("success") is False
        assert body.get("error"), "friendly error string missing"


class TestScheduledSelectedAccounts:
    def test_schedule_persists_selected_accounts(self, api):
        future = (datetime.now(timezone.utc) + timedelta(hours=6)).isoformat()
        r = api.post(
            f"{BASE_URL}/api/scheduled",
            json={
                "content": "hi",
                "platforms": ["linkedin"],
                "scheduled_for": future,
                "selected_accounts": {"linkedin": "conn_x"},
            },
        )
        assert r.status_code == 200, r.text
        doc = r.json()
        assert doc.get("selected_accounts", {}).get("linkedin") == "conn_x"
        assert doc.get("id")
        # cleanup
        try:
            requests.delete(
                f"{BASE_URL}/api/scheduled/{doc['id']}",
                headers={"X-User-Id": api.headers["X-User-Id"]},
                timeout=15,
            )
        except Exception:
            pass


# ------------------------- REGRESSION ------------------------- #

class TestRegression:
    def test_instagram_post_unconnected_clean_error(self, api):
        # Instagram requires an image before it will attempt to post — pass a tiny
        # 1x1 PNG so we actually exercise the unconnected-account path.
        tiny_png = (
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgYAAAAA"
            "MAASsJTYQAAAAASUVORK5CYII="
        )
        r = api.post(
            f"{BASE_URL}/api/social/instagram/post",
            json={"content": "hi", "image_b64": tiny_png, "image_mime": "image/png"},
            timeout=60,
        )
        assert r.status_code == 200, r.text
        body = r.json()
        assert body.get("success") is False
        assert body.get("error")

    def test_linkedin_post_unconnected_clean_error(self, api):
        r = api.post(
            f"{BASE_URL}/api/social/linkedin/post",
            json={"content": "hi"},
            timeout=60,
        )
        assert r.status_code == 200, r.text
        body = r.json()
        assert body.get("success") is False
        assert body.get("error")

    def test_per_platform_accounts_endpoint(self, api):
        r = api.get(f"{BASE_URL}/api/social/linkedin/accounts", timeout=60)
        assert r.status_code == 200, r.text
        body = r.json()
        assert body.get("platform") == "linkedin"
        assert "accounts" in body
        assert isinstance(body["accounts"], list)
