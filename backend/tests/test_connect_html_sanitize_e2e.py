"""End-to-end sanity checks against the deployed backend for the
'HTML-in-toast' iOS bug fix. Uses the real public URL from EXPO_PUBLIC_BACKEND_URL.

Contract to verify:
  * POST /api/social/{linkedin|facebook|instagram}/connect
      → HTTP 200 always
      → JSON envelope: {platform, success: bool, redirect_url? | error?}
      → response body NEVER contains HTML markers
  * GET  /api/social/{platform}/status       → 200
  * DELETE /api/social/{platform}/accounts/{bad_id} → not 500 and no HTML in body
"""
import os
import re
import uuid
import pytest
import requests

BASE_URL = (os.environ.get("EXPO_PUBLIC_BACKEND_URL") or "").rstrip("/")
assert BASE_URL, "EXPO_PUBLIC_BACKEND_URL must be set"

USER_ID = f"be-html-fix-e2e-{uuid.uuid4().hex[:8]}"
HEADERS = {"Content-Type": "application/json", "X-User-Id": USER_ID}
TIMEOUT = 30

HTML_MARKERS = ("<!doctype", "<html", "<!--[if", "cloudflare", "<body", "</html>",
                "<head", "<script", "<title")

PLATFORMS = ["linkedin", "facebook", "instagram"]


def _assert_no_html(text: str, ctx: str):
    low = text.lower()
    for m in HTML_MARKERS:
        assert m not in low, f"[{ctx}] HTML marker {m!r} leaked into body: {text[:400]!r}"


# ---------- connect endpoint contract ----------
@pytest.mark.parametrize("platform", PLATFORMS)
def test_connect_returns_200_and_no_html(platform):
    r = requests.post(
        f"{BASE_URL}/api/social/{platform}/connect",
        headers=HEADERS, json={}, timeout=TIMEOUT,
    )
    assert r.status_code == 200, f"{platform}: {r.status_code} {r.text[:400]}"
    _assert_no_html(r.text, f"POST /social/{platform}/connect")
    # Content-Type must be JSON
    assert "application/json" in r.headers.get("content-type", "").lower()
    j = r.json()
    assert j.get("platform") == platform
    # Envelope must be either success or friendly error
    if j.get("success") is True:
        assert isinstance(j.get("redirect_url"), str) and j["redirect_url"].strip()
        # Redirect URL must not embed HTML
        assert not re.search(r"<[a-z!/]", j["redirect_url"])
    else:
        assert j.get("success") is False
        err = j.get("error")
        assert isinstance(err, str) and err.strip(), f"empty error: {j!r}"
        # Error field itself must be HTML-free
        _assert_no_html(err, f"{platform}.error field")
        assert len(err) <= 300, f"error too long: {len(err)}"


@pytest.mark.parametrize("platform", PLATFORMS)
def test_connect_success_redirect_url_shape_live(platform):
    """When Composio returns a real redirect_url, ensure the shape is right.
    We treat a `success=false` as an accepted branch (upstream outage), but
    when success is true, the URL must be non-empty https:// link."""
    r = requests.post(
        f"{BASE_URL}/api/social/{platform}/connect",
        headers=HEADERS, json={}, timeout=TIMEOUT,
    )
    assert r.status_code == 200
    j = r.json()
    if j.get("success") is True:
        assert j["redirect_url"].startswith(("http://", "https://"))


# ---------- status endpoint ----------
@pytest.mark.parametrize("platform", PLATFORMS)
def test_status_endpoint_still_works(platform):
    r = requests.get(
        f"{BASE_URL}/api/social/{platform}/status",
        headers=HEADERS, timeout=TIMEOUT,
    )
    assert r.status_code == 200, r.text[:300]
    _assert_no_html(r.text, f"GET /social/{platform}/status")
    j = r.json()
    assert j.get("platform") == platform
    assert isinstance(j.get("connected"), bool)


# ---------- delete endpoint sanitization ----------
@pytest.mark.parametrize("platform", PLATFORMS)
def test_delete_bogus_account_no_html_and_not_500(platform):
    r = requests.delete(
        f"{BASE_URL}/api/social/{platform}/accounts/does-not-exist-{uuid.uuid4().hex[:6]}",
        headers=HEADERS, timeout=TIMEOUT,
    )
    assert r.status_code != 500, f"server crashed: {r.text[:300]}"
    _assert_no_html(r.text, f"DELETE /social/{platform}/accounts/<bogus>")
    # Should be JSON either success/detail — never HTML page
    ctype = r.headers.get("content-type", "").lower()
    assert "application/json" in ctype, f"non-JSON body: {ctype} / {r.text[:200]}"


# ---------- auth guard ----------
def test_connect_requires_user_id_header():
    r = requests.post(f"{BASE_URL}/api/social/linkedin/connect",
                      json={}, timeout=TIMEOUT)
    assert r.status_code == 401, r.text[:200]
    _assert_no_html(r.text, "unauth connect")
