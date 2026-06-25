"""
Iteration 5 backend regression tests for the Instagram (Composio) posting bug fix.

Two critical bugs from iteration 4 should now be fixed:
 1. tz-aware vs tz-naive datetime compare in GET /api/public/social-image/{id}
    — fixed by storing `expires_at` as an ISO string AND normalizing datetimes on read.
 2. HTTP 502 bodies were being rewritten to HTML by the preview edge proxy.
    — fixed by returning HTTP 200 with {success: false, platform, error: "..."} from
      `/api/social/{platform}/post` on every provider failure path.

Covers:
 - Public image hosting route GET /api/public/social-image/{img_id}
   (valid ISO-string expires_at, expired ISO-string, legacy tz-NAIVE datetime fallback)
 - Instagram posting endpoint validation + clean JSON 200 success:false error envelope
 - data: URI passed as image_url must be tolerated and hosted
 - LinkedIn regression: 200 + success:false with clean message (no HTML)
 - Scheduled post endpoint accepts Instagram
 - End-to-end through the public preview URL — verifies the edge does NOT rewrite the body

Auth: X-User-Id header (any string is accepted in dev mode).
"""
import os
import base64
import uuid
import asyncio
from datetime import datetime, timezone, timedelta
from pathlib import Path

import pytest
import requests
from dotenv import load_dotenv
from pymongo import MongoClient

# Load backend env so MONGO_URL/DB_NAME/PUBLIC_BACKEND_URL are visible to the test
BACKEND_ENV = Path("/app/backend/.env")
load_dotenv(dotenv_path=BACKEND_ENV)

# IMPORTANT: tests must hit the public URL the mobile/web frontend uses.
FRONTEND_ENV = Path("/app/frontend/.env")
load_dotenv(dotenv_path=FRONTEND_ENV, override=False)

BASE_URL = (
    os.environ.get("EXPO_PUBLIC_BACKEND_URL")
    or os.environ.get("EXPO_BACKEND_URL")
    or ""
).rstrip("/")
# Internal URL used to verify what the backend ITSELF returns — bypasses the
# Kubernetes/Cloudflare edge.
INTERNAL_URL = "http://localhost:8001"
MONGO_URL = os.environ["MONGO_URL"]
DB_NAME = os.environ["DB_NAME"]
PUBLIC_BACKEND_URL = (os.environ.get("PUBLIC_BACKEND_URL") or "").rstrip("/")

# 1x1 transparent PNG (smallest valid PNG)
TINY_PNG_BYTES = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNgAAIAAAUAAen63NgAAAAASUVORK5CYII="
)
TINY_PNG_B64 = base64.b64encode(TINY_PNG_BYTES).decode("ascii")


# ---------------- Fixtures ----------------
@pytest.fixture(scope="session")
def http():
    s = requests.Session()
    s.headers.update({"Content-Type": "application/json"})
    return s


@pytest.fixture(scope="session")
def user_id():
    return f"be-tester-ig-{uuid.uuid4().hex[:8]}"


@pytest.fixture(scope="session")
def auth_headers(user_id):
    return {"X-User-Id": user_id, "Content-Type": "application/json"}


def _mongo():
    client = MongoClient(MONGO_URL)
    return client[DB_NAME], client


@pytest.fixture(scope="session")
def event_loop():
    loop = asyncio.new_event_loop()
    yield loop
    loop.close()


def _assert_no_html(text: str, label: str = ""):
    low = (text or "").lower()
    assert "<!doctype" not in low, f"{label}: raw HTML leaked: {text[:200]}"
    assert "<html" not in low, f"{label}: raw HTML leaked: {text[:200]}"
    assert "bad gateway" not in low, f"{label}: raw 'Bad gateway' text leaked: {text[:200]}"


# ============================================================
# 1) PUBLIC IMAGE ROUTE  — GET /api/public/social-image/{id}
# ============================================================
class TestPublicImageRoute:
    """No auth required. 200 on valid id, 404 on unknown, 410 on expired.
    Re-verifies the iteration-4 fix: handler now tolerates both ISO-string
    and tz-naive/tz-aware datetime values for `expires_at`."""

    def test_unknown_id_returns_404(self, http):
        r = http.get(f"{BASE_URL}/api/public/social-image/does-not-exist-xyz")
        assert r.status_code == 404, r.text

    def test_valid_iso_string_expires_returns_png_200(self, http):
        """expires_at stored as ISO-formatted string in the future → 200 PNG."""
        img_id = f"TEST_{uuid.uuid4().hex}"
        db, client = _mongo()
        try:
            db.public_images.insert_one(
                {
                    "id": img_id,
                    "data": TINY_PNG_BYTES,
                    "mime": "image/png",
                    "created_at": datetime.now(timezone.utc).isoformat(),
                    "expires_at": (datetime.now(timezone.utc) + timedelta(hours=1)).isoformat(),
                }
            )
            r = requests.get(f"{BASE_URL}/api/public/social-image/{img_id}", timeout=30)
            assert r.status_code == 200, f"got {r.status_code}: {r.text[:300]}"
            assert r.headers.get("Content-Type", "").startswith("image/"), r.headers
            assert r.headers["Content-Type"].startswith("image/png")
            assert r.content == TINY_PNG_BYTES, "image bytes mismatch"
        finally:
            db.public_images.delete_one({"id": img_id})
            client.close()

    def test_expired_iso_string_returns_410(self, http):
        """expires_at as ISO-formatted string in the past → 410 Gone and doc removed."""
        img_id = f"TEST_EXP_{uuid.uuid4().hex}"
        db, client = _mongo()
        try:
            db.public_images.insert_one(
                {
                    "id": img_id,
                    "data": TINY_PNG_BYTES,
                    "mime": "image/png",
                    "created_at": (datetime.now(timezone.utc) - timedelta(hours=5)).isoformat(),
                    "expires_at": (datetime.now(timezone.utc) - timedelta(hours=1)).isoformat(),
                }
            )
            r = requests.get(f"{BASE_URL}/api/public/social-image/{img_id}", timeout=30)
            assert r.status_code == 410, f"expected 410, got {r.status_code}: {r.text[:300]}"
            # And the handler should clean up the expired doc
            assert db.public_images.find_one({"id": img_id}) is None, "expired doc not cleaned up"
        finally:
            db.public_images.delete_one({"id": img_id})
            client.close()

    def test_legacy_tz_naive_datetime_still_works(self, http):
        """LEGACY: docs written before the fix may have a tz-naive datetime in
        `expires_at`. The handler must normalize it to UTC, not 500."""
        img_id = f"TEST_LEGACY_{uuid.uuid4().hex}"
        db, client = _mongo()
        try:
            # Note: writing a naive datetime simulates the old code path. pymongo
            # also returns naive datetimes by default on read.
            naive_future = datetime.utcnow() + timedelta(hours=1)
            db.public_images.insert_one(
                {
                    "id": img_id,
                    "data": TINY_PNG_BYTES,
                    "mime": "image/png",
                    "created_at": datetime.utcnow(),
                    "expires_at": naive_future,
                }
            )
            r = requests.get(f"{BASE_URL}/api/public/social-image/{img_id}", timeout=30)
            assert r.status_code == 200, (
                f"legacy tz-naive datetime should be normalized — got {r.status_code}: {r.text[:300]}"
            )
            assert r.headers.get("Content-Type", "").startswith("image/png")
            assert r.content == TINY_PNG_BYTES
        finally:
            db.public_images.delete_one({"id": img_id})
            client.close()

    def test_legacy_tz_naive_expired_datetime_returns_410(self, http):
        """LEGACY expired path: naive datetime in the past → 410, not 500."""
        img_id = f"TEST_LEGACY_EXP_{uuid.uuid4().hex}"
        db, client = _mongo()
        try:
            naive_past = datetime.utcnow() - timedelta(hours=1)
            db.public_images.insert_one(
                {
                    "id": img_id,
                    "data": TINY_PNG_BYTES,
                    "mime": "image/png",
                    "created_at": datetime.utcnow() - timedelta(hours=5),
                    "expires_at": naive_past,
                }
            )
            r = requests.get(f"{BASE_URL}/api/public/social-image/{img_id}", timeout=30)
            assert r.status_code == 410, f"expected 410, got {r.status_code}: {r.text[:300]}"
        finally:
            db.public_images.delete_one({"id": img_id})
            client.close()


# ============================================================
# 2) INSTAGRAM POST ENDPOINT — VALIDATION + 200+success:false envelope
# ============================================================
class TestInstagramPostValidation:
    """Validation 400s pass through the edge (4xx bodies are NOT rewritten).
    Provider failures must now return 200 with {success: false, error: ...}."""

    def test_no_content_no_image_returns_400(self, http, auth_headers):
        r = http.post(
            f"{BASE_URL}/api/social/instagram/post",
            headers=auth_headers,
            json={},
        )
        assert r.status_code == 400, r.text
        assert "content is required" in r.text.lower() or "image" in r.text.lower()
        _assert_no_html(r.text, "ig 400 no content")

    def test_content_but_no_image_returns_400(self, http, auth_headers):
        r = http.post(
            f"{BASE_URL}/api/social/instagram/post",
            headers=auth_headers,
            json={"content": "Hello Instagram"},
        )
        assert r.status_code == 400, r.text
        body = r.text.lower()
        assert "instagram requires an image" in body or "image" in body
        _assert_no_html(r.text, "ig 400 no image")

    def test_content_plus_image_b64_no_connected_account_returns_200_success_false(
        self, http, auth_headers
    ):
        """Through the PUBLIC URL. Composio is hit live; the test user has no
        connected accounts so we expect 200 + {success: false, error: ...}
        with a clean human-readable message (NO HTML, NO 'Bad gateway')."""
        db, client = _mongo()
        try:
            before = db.public_images.count_documents({})
            r = http.post(
                f"{BASE_URL}/api/social/instagram/post",
                headers=auth_headers,
                json={
                    "content": "test post",
                    "image_b64": TINY_PNG_B64,
                    "image_mime": "image/png",
                },
                timeout=60,
            )
            after = db.public_images.count_documents({})

            assert r.status_code == 200, (
                f"expected 200 + success:false on provider failure, got {r.status_code}: {r.text[:300]}"
            )
            ct = r.headers.get("Content-Type", "").lower()
            assert "application/json" in ct, f"expected JSON, got {ct}: {r.text[:200]}"
            _assert_no_html(r.text, "ig public 200")

            data = r.json()
            assert data.get("success") is False, f"expected success:false, got {data}"
            assert data.get("platform") == "instagram"
            err = (data.get("error") or "").strip()
            assert err, f"empty error message: {data}"
            assert any(
                kw in err.lower()
                for kw in (
                    "instagram",
                    "connect",
                    "rejected",
                    "no connected",
                    "temporarily unreachable",
                    "not connected",
                )
            ), f"error message not human-friendly: {err}"

            # A new public_images doc should still have been created (hosted image URL).
            assert after >= before + 1, (
                f"backend should host the image publicly before calling Composio "
                f"(public_images count before={before}, after={after})"
            )
            latest = list(db.public_images.find().sort("_id", -1).limit(1))
            assert latest, "no public_images doc found after the call"
            doc = latest[0]
            assert doc.get("mime", "").startswith("image/"), f"unexpected mime: {doc.get('mime')}"
            assert isinstance(doc.get("data"), (bytes, bytearray)), "data not stored as bytes"
            # And expires_at should now be ISO string per the fix
            assert isinstance(doc.get("expires_at"), str), (
                f"expires_at should be ISO string post-fix, got: {type(doc.get('expires_at'))}"
            )
        finally:
            client.close()

    def test_data_uri_passed_as_image_url_is_handled(self, http, auth_headers):
        """Frontend regression scenario: image_url='data:image/png;base64,...' with
        no image_b64. Backend must decode, host, and return 200 + success:false
        (since the user has no IG account)."""
        data_uri = f"data:image/png;base64,{TINY_PNG_B64}"
        db, client = _mongo()
        try:
            before = db.public_images.count_documents({})
            r = http.post(
                f"{BASE_URL}/api/social/instagram/post",
                headers=auth_headers,
                json={"content": "data uri test", "image_url": data_uri},
                timeout=60,
            )
            after = db.public_images.count_documents({})

            assert r.status_code == 200, (
                f"Expected 200 (data-URI should be handled), got {r.status_code}: {r.text[:300]}"
            )
            _assert_no_html(r.text, "ig data-uri")
            data = r.json()
            # Could be success:false (no IG connected) — must NOT be a parse error.
            assert "success" in data
            assert after >= before + 1, (
                f"data-URI image_url should be decoded and hosted "
                f"(public_images count before={before}, after={after})"
            )
        finally:
            client.close()


# ============================================================
# 3) LINKEDIN REGRESSION — 200 + success:false, NO 502
# ============================================================
class TestLinkedInRegression:
    def test_linkedin_post_no_image_returns_200_success_false(self, http, auth_headers):
        """The URN-failure path used to raise HTTPException(502). It now returns
        200 + success:false (so the preview edge can't rewrite the body)."""
        r = http.post(
            f"{BASE_URL}/api/social/linkedin/post",
            headers=auth_headers,
            json={"content": "LinkedIn regression — text only"},
            timeout=60,
        )
        assert r.status_code == 200, (
            f"expected 200 + success:false, got {r.status_code}: {r.text[:300]}"
        )
        ct = r.headers.get("Content-Type", "").lower()
        assert "application/json" in ct, f"expected JSON, got {ct}"
        _assert_no_html(r.text, "linkedin")
        data = r.json()
        assert data.get("success") is False, f"expected success:false, got {data}"
        assert data.get("platform") == "linkedin"
        err = (data.get("error") or "").lower()
        assert err, f"empty error: {data}"
        # Must mention something LinkedIn-related so we know the cleaner ran.
        assert any(k in err for k in ("linkedin", "connect", "profile", "urn", "not connected")), (
            f"error message not human-friendly: {err}"
        )


# ============================================================
# 4) EDGE NO LONGER REWRITES BODY — JSON preserved through the edge
# ============================================================
class TestEdgePreservesJsonBody:
    """Iteration 4 documented that the edge proxy was replacing 5xx bodies with
    raw HTML. The fix is to return HTTP 200 + success:false so the body passes
    through unchanged. This test confirms the JSON envelope reaches the caller."""

    def test_linkedin_failure_json_envelope_preserved_through_edge(self, http, auth_headers):
        # Direct call vs the public URL — both should yield the same JSON.
        public = http.post(
            f"{BASE_URL}/api/social/linkedin/post",
            headers=auth_headers,
            json={"content": "edge preservation test"},
            timeout=60,
        )
        internal = http.post(
            f"{INTERNAL_URL}/api/social/linkedin/post",
            headers=auth_headers,
            json={"content": "edge preservation test"},
            timeout=60,
        )
        for label, r in (("public", public), ("internal", internal)):
            assert r.status_code == 200, f"{label}: status {r.status_code}: {r.text[:200]}"
            _assert_no_html(r.text, label)
            d = r.json()
            assert d.get("success") is False
            assert d.get("platform") == "linkedin"
            assert isinstance(d.get("error"), str) and d["error"], f"{label}: no error msg"

    def test_instagram_failure_json_envelope_preserved_through_edge(self, http, auth_headers):
        r = http.post(
            f"{BASE_URL}/api/social/instagram/post",
            headers=auth_headers,
            json={
                "content": "edge preservation IG",
                "image_b64": TINY_PNG_B64,
                "image_mime": "image/png",
            },
            timeout=60,
        )
        assert r.status_code == 200, f"status {r.status_code}: {r.text[:300]}"
        ct = r.headers.get("Content-Type", "").lower()
        assert "application/json" in ct, f"expected json, got {ct}"
        _assert_no_html(r.text, "ig edge")
        d = r.json()
        assert d.get("success") is False
        assert d.get("platform") == "instagram"


# ============================================================
# 5) PUBLIC IMAGE ROUTE THROUGH THE EDGE
# ============================================================
class TestPublicImageThroughEdge:
    def test_fresh_image_served_through_public_url(self):
        img_id = f"TEST_EDGE_{uuid.uuid4().hex}"
        db, client = _mongo()
        try:
            db.public_images.insert_one(
                {
                    "id": img_id,
                    "data": TINY_PNG_BYTES,
                    "mime": "image/png",
                    "created_at": datetime.now(timezone.utc).isoformat(),
                    "expires_at": (datetime.now(timezone.utc) + timedelta(hours=1)).isoformat(),
                }
            )
            r = requests.get(f"{BASE_URL}/api/public/social-image/{img_id}", timeout=30)
            assert r.status_code == 200, f"got {r.status_code}: {r.text[:200]}"
            assert r.headers.get("Content-Type", "").startswith("image/png"), r.headers
            assert r.content == TINY_PNG_BYTES
        finally:
            db.public_images.delete_one({"id": img_id})
            client.close()


# ============================================================
# 6) SCHEDULED POST ACCEPTS INSTAGRAM (regression)
# ============================================================
class TestScheduledPostInstagram:
    def test_create_scheduled_instagram_post_succeeds(self, http, auth_headers):
        scheduled_for = (datetime.now(timezone.utc) + timedelta(days=1)).isoformat()
        payload = {
            "content": "TEST_scheduled_ig",
            "platforms": ["instagram"],
            "scheduled_for": scheduled_for,
            "image_b64": TINY_PNG_B64,
            "image_mime": "image/png",
        }
        r = http.post(
            f"{BASE_URL}/api/scheduled",
            headers=auth_headers,
            json=payload,
            timeout=20,
        )
        assert r.status_code == 200, r.text
        data = r.json()
        assert data.get("id"), "scheduled doc missing id"
        assert data.get("platforms") == ["instagram"]
        assert data.get("status") == "scheduled"
        assert "image_b64" not in data
        sched_id = data["id"]

        list_resp = http.get(f"{BASE_URL}/api/scheduled", headers=auth_headers, timeout=20)
        assert list_resp.status_code == 200
        items = list_resp.json().get("items", [])
        assert any(i.get("id") == sched_id for i in items), "scheduled item not visible in list"

        del_resp = http.delete(
            f"{BASE_URL}/api/scheduled/{sched_id}", headers=auth_headers, timeout=20
        )
        assert del_resp.status_code == 200
        assert del_resp.json().get("deleted") == 1

    def test_create_scheduled_post_bad_datetime_returns_400(self, http, auth_headers):
        r = http.post(
            f"{BASE_URL}/api/scheduled",
            headers=auth_headers,
            json={
                "content": "x",
                "platforms": ["instagram"],
                "scheduled_for": "not-a-date",
                "image_b64": TINY_PNG_B64,
                "image_mime": "image/png",
            },
            timeout=20,
        )
        assert r.status_code == 400, r.text


# ============================================================
# 7) STATUS + ACCOUNTS ENDPOINTS (regression)
# ============================================================
class TestSocialStatusEndpoints:
    @pytest.mark.parametrize("platform", ["linkedin", "instagram", "facebook"])
    def test_status_endpoint_returns_200(self, http, auth_headers, platform):
        r = http.get(
            f"{BASE_URL}/api/social/{platform}/status",
            headers=auth_headers,
            timeout=30,
        )
        assert r.status_code == 200, f"{platform}: {r.status_code}: {r.text[:200]}"
        _assert_no_html(r.text, f"{platform} status")
        data = r.json()
        assert data.get("platform") == platform
        # Just verify the shape — `connected` value depends on Composio account state.
        assert "connected" in data and "configured" in data, data

    @pytest.mark.parametrize("platform", ["linkedin", "instagram", "facebook"])
    def test_accounts_endpoint_returns_200(self, http, auth_headers, platform):
        r = http.get(
            f"{BASE_URL}/api/social/{platform}/accounts",
            headers=auth_headers,
            timeout=30,
        )
        # accounts may legitimately 404 if the route doesn't exist; if so we skip
        if r.status_code == 404:
            pytest.skip(f"{platform}/accounts endpoint not implemented")
        assert r.status_code == 200, f"{platform}: {r.status_code}: {r.text[:200]}"
        _assert_no_html(r.text, f"{platform} accounts")


# ============================================================
# 8) PUBLIC_BACKEND_URL ENV SHAPE (sanity for the fix)
# ============================================================
def test_public_backend_url_env_is_https():
    """The fix relies on PUBLIC_BACKEND_URL being a real HTTPS URL."""
    assert PUBLIC_BACKEND_URL.startswith("https://"), (
        f"PUBLIC_BACKEND_URL must be a real https URL, got: {PUBLIC_BACKEND_URL!r}"
    )
