"""Multi-account social UI backend tests.

Covers:
- GET /api/social/{platform}/accounts (linkedin/facebook/instagram)
- DELETE /api/social/{platform}/accounts/{conn_id}
- POST /api/companies/{id}/link-account (set, clear, 404, 400)
- POST /api/social/{platform}/connect (allow_multiple)
- GET /api/companies (active_id + linked_accounts visibility)
- Scheduler picks up scheduled_for in the past and fails gracefully.
"""
import os
import time
import uuid
import datetime as dt
import pytest
import requests

BASE_URL = (os.environ.get("EXPO_PUBLIC_BACKEND_URL") or "http://localhost:8001").rstrip("/")
USER_ID = f"be-multi-{uuid.uuid4().hex[:8]}"
HEADERS = {"Content-Type": "application/json", "X-User-Id": USER_ID}
TIMEOUT = 30

PLATFORMS = ["linkedin", "facebook", "instagram"]

state = {}


@pytest.fixture(scope="module")
def s():
    sess = requests.Session()
    sess.headers.update(HEADERS)
    return sess


# ---------- Social accounts listing ----------
@pytest.mark.parametrize("platform", PLATFORMS)
def test_list_social_accounts_shape(s, platform):
    r = s.get(f"{BASE_URL}/api/social/{platform}/accounts", timeout=TIMEOUT)
    assert r.status_code == 200, f"{platform}: {r.status_code} {r.text}"
    j = r.json()
    assert j.get("platform") == platform
    assert isinstance(j.get("accounts"), list)
    assert isinstance(j.get("configured"), bool)
    # Fresh test user → no real OAuth → expect empty accounts
    assert j["accounts"] == []
    assert j["configured"] is True


def test_list_social_accounts_unknown_platform(s):
    r = s.get(f"{BASE_URL}/api/social/twitter/accounts", timeout=TIMEOUT)
    assert r.status_code == 404


def test_list_social_accounts_requires_user(s):
    r = requests.get(f"{BASE_URL}/api/social/linkedin/accounts", timeout=TIMEOUT)
    assert r.status_code == 401


# ---------- Delete social account (graceful failure on bogus id) ----------
def test_delete_social_account_bogus_id_returns_502_not_crash(s):
    r = s.delete(f"{BASE_URL}/api/social/linkedin/accounts/does-not-exist-xyz", timeout=TIMEOUT)
    # composio will reject → 502 with truncated message, server should NOT 500
    assert r.status_code in (502, 200, 404), r.text
    assert r.status_code != 500
    # Subsequent listing must still work (no global crash)
    r2 = s.get(f"{BASE_URL}/api/social/linkedin/accounts", timeout=TIMEOUT)
    assert r2.status_code == 200


# ---------- Companies & link-account ----------
def test_companies_list_initial(s):
    r = s.get(f"{BASE_URL}/api/companies", timeout=TIMEOUT)
    assert r.status_code == 200, r.text
    j = r.json()
    assert "items" in j and isinstance(j["items"], list)
    assert "active_id" in j  # may be None
    state["initial_items"] = j["items"]


def test_create_company(s):
    payload = {"name": "TEST_MultiCo Inc", "website": "https://example.test"}
    r = s.post(f"{BASE_URL}/api/companies", json=payload, timeout=TIMEOUT)
    assert r.status_code == 200, r.text
    j = r.json()
    assert "_id" not in j
    assert j["name"] == "TEST_MultiCo Inc"
    assert j["user_id"] == USER_ID
    state["company_id"] = j["id"]


def test_link_account_set(s):
    cid = state.get("company_id")
    assert cid
    body = {"platform": "linkedin", "connected_account_id": "ca_test_xyz"}
    r = s.post(f"{BASE_URL}/api/companies/{cid}/link-account", json=body, timeout=TIMEOUT)
    assert r.status_code == 200, r.text
    j = r.json()
    assert "_id" not in j
    assert j.get("linked_accounts", {}).get("linkedin") == "ca_test_xyz"


def test_link_account_visible_in_companies_list(s):
    r = s.get(f"{BASE_URL}/api/companies", timeout=TIMEOUT)
    assert r.status_code == 200
    j = r.json()
    cid = state["company_id"]
    item = next((c for c in j["items"] if c["id"] == cid), None)
    assert item is not None
    assert item.get("linked_accounts", {}).get("linkedin") == "ca_test_xyz"


def test_link_account_clear_with_null(s):
    cid = state["company_id"]
    body = {"platform": "linkedin", "connected_account_id": None}
    r = s.post(f"{BASE_URL}/api/companies/{cid}/link-account", json=body, timeout=TIMEOUT)
    assert r.status_code == 200, r.text
    j = r.json()
    # Field should be removed (unset) or absent
    assert (j.get("linked_accounts") or {}).get("linkedin") in (None, "")


def test_link_account_invalid_company(s):
    body = {"platform": "linkedin", "connected_account_id": "ca_x"}
    r = s.post(f"{BASE_URL}/api/companies/no-such-id/link-account", json=body, timeout=TIMEOUT)
    assert r.status_code == 404, r.text


def test_link_account_unknown_platform(s):
    cid = state["company_id"]
    body = {"platform": "tiktok", "connected_account_id": "ca_x"}
    r = s.post(f"{BASE_URL}/api/companies/{cid}/link-account", json=body, timeout=TIMEOUT)
    assert r.status_code == 400, r.text


def test_link_account_empty_string_clears(s):
    cid = state["company_id"]
    # Set first
    s.post(f"{BASE_URL}/api/companies/{cid}/link-account",
           json={"platform": "facebook", "connected_account_id": "ca_fb_1"}, timeout=TIMEOUT)
    # Now clear with empty string
    r = s.post(f"{BASE_URL}/api/companies/{cid}/link-account",
               json={"platform": "facebook", "connected_account_id": ""}, timeout=TIMEOUT)
    assert r.status_code == 200
    j = r.json()
    assert (j.get("linked_accounts") or {}).get("facebook") in (None, "")


# ---------- Connect endpoint (allow_multiple) ----------
def test_connect_linkedin_returns_redirect_or_already(s):
    r = s.post(f"{BASE_URL}/api/social/linkedin/connect", json={}, timeout=TIMEOUT)
    # Either a redirect URL or already_connected, NOT a 500
    assert r.status_code in (200, 502), r.text
    if r.status_code == 200:
        j = r.json()
        assert j.get("platform") == "linkedin"
        # Either redirect_url is set OR already_connected flag is set
        assert j.get("redirect_url") or j.get("already_connected")


# ---------- Scheduler ----------
def test_scheduler_picks_up_post_and_fails_gracefully(s):
    """Schedule a post 5s ahead, then poll for up to ~80s.
    Since there's no real LinkedIn account, status should land on 'failed'."""
    scheduled_for = (dt.datetime.now(dt.timezone.utc) + dt.timedelta(seconds=5)).isoformat()
    body = {
        "platforms": ["linkedin"],
        "scheduled_for": scheduled_for,
        "content": "TEST_scheduled multi-account",
    }
    r = s.post(f"{BASE_URL}/api/scheduled", json=body, timeout=TIMEOUT)
    assert r.status_code == 200, r.text
    j = r.json()
    sched_id = j["id"]
    assert j["status"] == "scheduled"

    # Poll for up to ~80s (scheduler runs every 60s)
    final = None
    for _ in range(17):  # 17 * 5 = 85s
        time.sleep(5)
        lst = s.get(f"{BASE_URL}/api/scheduled", timeout=TIMEOUT).json()
        item = next((x for x in lst.get("items", []) if x["id"] == sched_id), None)
        if item and item["status"] in ("posted", "failed"):
            final = item
            break
    assert final is not None, "Scheduler did not transition status within 85s"
    assert final["status"] == "failed", f"Expected failed (no real account), got {final['status']}: {final}"
    assert isinstance(final.get("results"), list)
    assert len(final["results"]) >= 1
    assert final["results"][0]["success"] is False
    assert "error" in final["results"][0]


# ---------- Cleanup ----------
def test_zz_cleanup(s):
    cid = state.get("company_id")
    if cid:
        s.delete(f"{BASE_URL}/api/companies/{cid}", timeout=TIMEOUT)
