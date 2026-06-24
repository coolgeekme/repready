"""Company Detail screen backend tests.

Covers (priority-medium endpoints called by the new /company/[id] screen):
- GET /api/companies returns {items, active_id} shape.
- POST /api/companies creates a doc with id/user_id/name/linked_accounts.
- PUT /api/companies/{id} accepts partial updates and persists all CompanyIn fields.
- POST /api/companies/{id}/link-account body {platform, connected_account_id}
- POST /api/companies/{id}/activate sets active_id.
- DELETE /api/companies/{id} removes & shifts active.
- POST /api/company/autofill returns offerings/value_props/industry/target_audience.
"""
import os
import uuid
import pytest
import requests

BASE_URL = (os.environ.get("EXPO_PUBLIC_BACKEND_URL") or "http://localhost:8001").rstrip("/")
USER_ID = f"be-company-{uuid.uuid4().hex[:8]}"
HEADERS = {"Content-Type": "application/json", "X-User-Id": USER_ID}
TIMEOUT = 30

state: dict = {}


@pytest.fixture(scope="module")
def s():
    sess = requests.Session()
    sess.headers.update(HEADERS)
    yield sess
    # cleanup any companies left behind
    try:
        items = sess.get(f"{BASE_URL}/api/companies", timeout=TIMEOUT).json().get("items", [])
        for it in items:
            sess.delete(f"{BASE_URL}/api/companies/{it['id']}", timeout=TIMEOUT)
    except Exception:
        pass


# ---------- GET shape ----------
def test_companies_get_shape(s):
    r = s.get(f"{BASE_URL}/api/companies", timeout=TIMEOUT)
    assert r.status_code == 200, r.text
    j = r.json()
    assert "items" in j and isinstance(j["items"], list)
    assert "active_id" in j  # may be None for fresh user
    for item in j["items"]:
        assert "_id" not in item


# ---------- POST creates company ----------
def test_create_company_minimal(s):
    r = s.post(f"{BASE_URL}/api/companies", json={"name": "TEST_Acme Inc"}, timeout=TIMEOUT)
    assert r.status_code == 200, r.text
    c = r.json()
    assert "_id" not in c
    assert c["id"]
    assert c["user_id"] == USER_ID
    assert c["name"] == "TEST_Acme Inc"
    state["acme_id"] = c["id"]
    # Verify persisted via GET
    g = s.get(f"{BASE_URL}/api/companies", timeout=TIMEOUT).json()
    ids = [x["id"] for x in g["items"]]
    assert c["id"] in ids
    # First created company should become active
    assert g["active_id"] == c["id"]


def test_create_company_rejects_blank_name(s):
    r = s.post(f"{BASE_URL}/api/companies", json={"name": "   "}, timeout=TIMEOUT)
    assert r.status_code == 400, r.text


# ---------- PUT partial update persists every field ----------
def test_update_company_full_fields(s):
    cid = state["acme_id"]
    payload = {
        "name": "TEST_Acme Inc",
        "website": "https://acme.test",
        "offerings": "B2B SaaS for sales reps.",
        "value_props": "• Faster onboarding\n• Native CRM sync",
        "industry": "SaaS",
        "target_audience": "VPs of Sales at mid-market SaaS",
    }
    r = s.put(f"{BASE_URL}/api/companies/{cid}", json=payload, timeout=TIMEOUT)
    assert r.status_code == 200, r.text
    updated = r.json()
    assert "_id" not in updated
    for k, v in payload.items():
        assert updated[k] == v, f"field {k} not persisted, got {updated.get(k)!r}"

    # GET again to confirm persistence
    g = s.get(f"{BASE_URL}/api/companies", timeout=TIMEOUT).json()
    item = next(x for x in g["items"] if x["id"] == cid)
    for k, v in payload.items():
        assert item[k] == v


def test_update_company_404(s):
    r = s.put(f"{BASE_URL}/api/companies/no-such-id", json={"name": "Whatever"}, timeout=TIMEOUT)
    assert r.status_code == 404


# ---------- Link account ----------
def test_link_account_set_and_visible(s):
    cid = state["acme_id"]
    r = s.post(
        f"{BASE_URL}/api/companies/{cid}/link-account",
        json={"platform": "linkedin", "connected_account_id": "ca_test_link_1"},
        timeout=TIMEOUT,
    )
    assert r.status_code == 200, r.text
    j = r.json()
    assert (j.get("linked_accounts") or {}).get("linkedin") == "ca_test_link_1"

    # Verify in list endpoint
    g = s.get(f"{BASE_URL}/api/companies", timeout=TIMEOUT).json()
    item = next(x for x in g["items"] if x["id"] == cid)
    assert item["linked_accounts"]["linkedin"] == "ca_test_link_1"


def test_link_account_clear_with_null(s):
    cid = state["acme_id"]
    r = s.post(
        f"{BASE_URL}/api/companies/{cid}/link-account",
        json={"platform": "linkedin", "connected_account_id": None},
        timeout=TIMEOUT,
    )
    assert r.status_code == 200, r.text
    j = r.json()
    assert (j.get("linked_accounts") or {}).get("linkedin") in (None, "")


# ---------- Activate (set active for new generations) ----------
def test_activate_company(s):
    # Create a second company
    r = s.post(f"{BASE_URL}/api/companies", json={"name": "TEST_Beta Corp"}, timeout=TIMEOUT)
    assert r.status_code == 200
    beta = r.json()
    state["beta_id"] = beta["id"]

    # Activate beta
    r2 = s.post(f"{BASE_URL}/api/companies/{beta['id']}/activate", timeout=TIMEOUT)
    assert r2.status_code == 200, r2.text
    assert r2.json().get("active_id") == beta["id"]

    # Verify in GET
    g = s.get(f"{BASE_URL}/api/companies", timeout=TIMEOUT).json()
    assert g["active_id"] == beta["id"]


def test_activate_unknown_404(s):
    r = s.post(f"{BASE_URL}/api/companies/no-such/activate", timeout=TIMEOUT)
    assert r.status_code == 404


# ---------- Delete & active shifts ----------
def test_delete_company_shifts_active(s):
    beta_id = state["beta_id"]
    r = s.delete(f"{BASE_URL}/api/companies/{beta_id}", timeout=TIMEOUT)
    assert r.status_code == 200
    assert r.json().get("deleted") == 1

    g = s.get(f"{BASE_URL}/api/companies", timeout=TIMEOUT).json()
    ids = [x["id"] for x in g["items"]]
    assert beta_id not in ids
    # Active should have shifted to remaining company (acme)
    assert g["active_id"] == state["acme_id"]


# ---------- Autofill ----------
def test_company_autofill_returns_fields(s):
    # Use a real domain so the LLM has context; allow up to 30s
    r = s.post(
        f"{BASE_URL}/api/company/autofill",
        json={"company_name": "Linear", "company_website": "linear.app"},
        timeout=60,
    )
    assert r.status_code == 200, r.text
    j = r.json()
    # API contract: returns offerings/value_props/industry/target_audience + fetched_site flag
    for k in ("company_offerings", "company_value_props", "industry", "target_audience"):
        assert k in j, f"autofill missing {k}: {j}"
    # At least one of the text fields should be a non-empty string
    assert any(isinstance(j[k], str) and j[k].strip() for k in ("company_offerings", "company_value_props")), j
