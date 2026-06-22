"""RepReady backend API tests against public EXPO_PUBLIC_BACKEND_URL."""
import os
import uuid
import pytest
import requests
from dotenv import load_dotenv
from pathlib import Path

load_dotenv(Path(__file__).resolve().parents[2] / "frontend" / ".env")
BASE_URL = os.environ.get("EXPO_PUBLIC_BACKEND_URL", "").rstrip("/")
assert BASE_URL, "EXPO_PUBLIC_BACKEND_URL not set"

USER_ID = f"be-test-{uuid.uuid4().hex[:8]}"
HEADERS = {"Content-Type": "application/json", "X-User-Id": USER_ID}
TIMEOUT = 90  # LLM calls are slow

state = {}


@pytest.fixture(scope="session")
def s():
    sess = requests.Session()
    sess.headers.update(HEADERS)
    return sess


# ---------- Health ----------
def test_root(s):
    r = s.get(f"{BASE_URL}/api/", timeout=15)
    assert r.status_code == 200
    j = r.json()
    assert "name" in j and "RepReady" in j["name"]


# ---------- Auth header enforcement ----------
def test_missing_user_id_401():
    r = requests.get(f"{BASE_URL}/api/users/profile", timeout=15)
    assert r.status_code == 401


# ---------- Profile ----------
def test_update_profile(s):
    payload = {
        "role": "AE",
        "industry": "SaaS",
        "target_audience": "VPs of Eng at mid-market SaaS",
        "guidelines_text": "Be concise. Brand-friendly tone.",
    }
    r = s.put(f"{BASE_URL}/api/users/profile", json=payload, timeout=20)
    assert r.status_code == 200, r.text
    j = r.json()
    assert "_id" not in j
    assert j["role"] == "AE"
    assert j["user_id"] == USER_ID


def test_get_profile(s):
    r = s.get(f"{BASE_URL}/api/users/profile", timeout=15)
    assert r.status_code == 200
    j = r.json()
    assert "_id" not in j
    assert j.get("role") == "AE"
    assert j.get("industry") == "SaaS"


# ---------- Daily Prompt ----------
def test_daily_prompt(s):
    r = s.get(f"{BASE_URL}/api/daily-prompt", timeout=TIMEOUT)
    assert r.status_code == 200, r.text
    j = r.json()
    assert "focus" in j
    assert isinstance(j.get("action_steps"), list)
    assert len(j["action_steps"]) == 3
    assert "quote" in j


# ---------- Generators ----------
def test_generate_cold_email(s):
    body = {"company_name": "Acme", "contact_name": "Jane", "product_pitch": "We cut onboarding by 40%"}
    r = s.post(f"{BASE_URL}/api/generate/cold-email", json=body, timeout=TIMEOUT)
    assert r.status_code == 200, r.text
    j = r.json()
    state["cold_id"] = j["id"]
    variations = j["output"]["variations"]
    assert isinstance(variations, list) and len(variations) >= 3
    for v in variations[:3]:
        assert "subject" in v and "body" in v and "style" in v


def test_generate_objection(s):
    r = s.post(f"{BASE_URL}/api/generate/objection-response",
               json={"objection": "Too expensive", "product_pitch": "ROI in 90 days"}, timeout=TIMEOUT)
    assert r.status_code == 200, r.text
    j = r.json()
    responses = j["output"]["responses"]
    assert isinstance(responses, list) and len(responses) >= 3
    for x in responses[:3]:
        assert "approach" in x and "script" in x


def test_generate_call_script(s):
    r = s.post(f"{BASE_URL}/api/generate/call-script",
               json={"company_name": "Acme", "contact_name": "Jane", "product_pitch": "Sales enablement"},
               timeout=TIMEOUT)
    assert r.status_code == 200, r.text
    out = r.json()["output"]
    assert isinstance(out.get("openers"), list) and len(out["openers"]) >= 2
    assert isinstance(out.get("discovery_questions"), list)
    assert all(isinstance(q, str) for q in out["discovery_questions"])


def test_generate_company_intel(s):
    r = s.post(f"{BASE_URL}/api/generate/company-intel",
               json={"company_name": "Stripe", "contact_name": "Patrick", "contact_title": "CEO"},
               timeout=TIMEOUT)
    assert r.status_code == 200, r.text
    out = r.json()["output"]
    assert isinstance(out.get("personalization_hooks"), list) and len(out["personalization_hooks"]) >= 1
    assert isinstance(out.get("likely_priorities"), list)


def test_generate_reengagement(s):
    r = s.post(f"{BASE_URL}/api/generate/re-engagement",
               json={"company_name": "Acme", "contact_name": "Jane", "product_pitch": "ROI in 90 days"},
               timeout=TIMEOUT)
    assert r.status_code == 200, r.text
    out = r.json()["output"]
    assert isinstance(out.get("angles"), list) and len(out["angles"]) >= 3


def test_generate_linkedin_post(s):
    r = s.post(f"{BASE_URL}/api/generate/linkedin-post",
               json={"topic": "First enterprise deal", "tone": "authentic"}, timeout=TIMEOUT)
    assert r.status_code == 200, r.text
    out = r.json()["output"]
    assert isinstance(out.get("variations"), list) and len(out["variations"]) >= 1
    v = out["variations"][0]
    assert "hook" in v and "body" in v and "hashtags" in v


# ---------- History ----------
def test_history_populated(s):
    r = s.get(f"{BASE_URL}/api/history", timeout=20)
    assert r.status_code == 200
    j = r.json()
    assert "items" in j and isinstance(j["items"], list)
    assert len(j["items"]) >= 1
    state["hist_id"] = j["items"][0]["id"]
    for it in j["items"]:
        assert "_id" not in it


def test_history_toggle_save(s):
    hid = state.get("hist_id")
    assert hid
    r = s.post(f"{BASE_URL}/api/history/{hid}/save", timeout=15)
    assert r.status_code == 200
    assert r.json()["saved"] is True
    # Verify in list
    r2 = s.get(f"{BASE_URL}/api/history?saved_only=true", timeout=15)
    ids = [i["id"] for i in r2.json()["items"]]
    assert hid in ids


def test_history_delete(s):
    hid = state.get("hist_id")
    r = s.delete(f"{BASE_URL}/api/history/{hid}", timeout=15)
    assert r.status_code == 200
    assert r.json()["deleted"] == 1
    # GET history list should not contain it
    r2 = s.get(f"{BASE_URL}/api/history", timeout=15)
    ids = [i["id"] for i in r2.json()["items"]]
    assert hid not in ids


# ---------- Composio LinkedIn ----------
def test_linkedin_status(s):
    r = s.get(f"{BASE_URL}/api/composio/linkedin/status", timeout=15)
    assert r.status_code == 200
    j = r.json()
    assert "connected" in j and "connection_id" in j
    assert j["connected"] is False
