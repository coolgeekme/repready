from fastapi import FastAPI, APIRouter, HTTPException, Header, Depends, Request
from fastapi.responses import Response
from dotenv import load_dotenv
from starlette.middleware.cors import CORSMiddleware
from motor.motor_asyncio import AsyncIOMotorClient
import os
import logging
import json
import uuid
import re
import secrets
import base64
from pathlib import Path
from pydantic import BaseModel, Field
from typing import List, Optional, Dict, Any
from datetime import datetime, timezone, timedelta

from emergentintegrations.llm.chat import LlmChat, UserMessage  # noqa: F401
import httpx

ROOT_DIR = Path(__file__).parent
load_dotenv(ROOT_DIR / ".env")

# ---------- Setup ----------
mongo_url = os.environ["MONGO_URL"]
client = AsyncIOMotorClient(mongo_url)
db = client[os.environ["DB_NAME"]]

EMERGENT_LLM_KEY = os.environ["EMERGENT_LLM_KEY"]
COMPOSIO_API_KEY = os.environ["COMPOSIO_API_KEY"]
SOCIAL_AUTH_CONFIGS: Dict[str, str] = {
    "linkedin": os.environ.get("LINKEDIN_AUTH_CONFIG_ID", "").strip(),
    "facebook": os.environ.get("FACEBOOK_AUTH_CONFIG_ID", "").strip(),
    "instagram": os.environ.get("INSTAGRAM_AUTH_CONFIG_ID", "").strip(),
}
LINKEDIN_AUTH_CONFIG_ID = SOCIAL_AUTH_CONFIGS["linkedin"]
CLAUDE_MODEL = "claude-sonnet-4-5-20250929"

app = FastAPI(title="RepReady API")
api_router = APIRouter(prefix="/api")

logging.basicConfig(level=logging.INFO, format="%(asctime)s - %(levelname)s - %(message)s")
logger = logging.getLogger(__name__)


# ---------- Auth dep ----------
async def get_user_id(
    x_user_id: Optional[str] = Header(None),
    x_user_email: Optional[str] = Header(None),
) -> str:
    """For MVP we trust the Firebase UID passed from the authenticated client.
    Firebase JS SDK is the source of truth for auth on the client.
    If X-User-Email is also provided, we lazily seed it into the user doc so
    admin/email-based features (comps, ADMIN_EMAILS) work from the first request.
    """
    if not x_user_id:
        raise HTTPException(status_code=401, detail="Missing X-User-Id header")
    # Lazy email seed (fire-and-forget) — keeps user.email + is_admin in sync with client
    if x_user_email:
        try:
            update_set: Dict[str, Any] = {"email": x_user_email}
            if x_user_email.strip().lower() in ADMIN_EMAILS:
                update_set["is_admin"] = True
            await db.users.update_one(
                {"user_id": x_user_id},
                {"$set": update_set, "$setOnInsert": {"user_id": x_user_id}},
                upsert=True,
            )
        except Exception as e:
            logging.warning(f"Email seed failed for {x_user_id}: {e}")
    return x_user_id


# ---------- Models ----------
class UserProfile(BaseModel):
    user_id: str
    email: Optional[str] = None
    display_name: Optional[str] = None
    role: Optional[str] = None
    industry: Optional[str] = None
    target_audience: Optional[str] = None
    # Active company reference (multi-company support)
    active_company_id: Optional[str] = None
    # Legacy fields preserved for backward compatibility
    company_name: Optional[str] = None
    company_website: Optional[str] = None
    company_offerings: Optional[str] = None
    company_value_props: Optional[str] = None
    guidelines_text: Optional[str] = None
    guidelines_file_name: Optional[str] = None
    guidelines_file_b64: Optional[str] = None  # base64 PDF
    linkedin_connected: bool = False
    linkedin_connection_id: Optional[str] = None
    # ---- Subscription / monetization fields (future-proofing for paywalls) ----
    # subscription_tier: "free" | "pro" | "enterprise"
    subscription_tier: str = "free"
    # subscription_source: where the entitlement comes from. "none" | "apple" | "stripe" | "admin_comp"
    subscription_source: str = "none"
    # When the paid subscription expires (ISO datetime, UTC). None == no active paid sub.
    subscription_expires_at: Optional[datetime] = None
    # Apple receipt anchor (used to dedupe + validate IAP receipts when we add StoreKit)
    apple_original_transaction_id: Optional[str] = None
    # Stripe customer (for any web/B2B Stripe billing)
    stripe_customer_id: Optional[str] = None
    # Admin-granted comp until this datetime — overrides everything. Used for friends/family.
    admin_comp_until: Optional[datetime] = None
    # Reason/notes attached to last admin grant (e.g. "Beta tester", "Family")
    admin_comp_note: Optional[str] = None
    # Is THIS user an admin (can grant comps)? Set via ADMIN_EMAILS env on first login.
    is_admin: bool = False
    updated_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))


class ProfileUpdate(BaseModel):
    email: Optional[str] = None
    display_name: Optional[str] = None
    role: Optional[str] = None
    industry: Optional[str] = None
    target_audience: Optional[str] = None
    active_company_id: Optional[str] = None
    guidelines_text: Optional[str] = None
    guidelines_file_name: Optional[str] = None
    guidelines_file_b64: Optional[str] = None


class CompanyIn(BaseModel):
    name: str
    website: Optional[str] = None
    offerings: Optional[str] = None
    value_props: Optional[str] = None
    industry: Optional[str] = None
    target_audience: Optional[str] = None
    guidelines_text: Optional[str] = None


class ScheduledPostIn(BaseModel):
    content: str
    platforms: List[str]  # e.g. ["linkedin", "facebook"]
    scheduled_for: str  # ISO datetime string
    image_b64: Optional[str] = None
    image_mime: Optional[str] = None
    history_id: Optional[str] = None


class GenerateRequest(BaseModel):
    # Common context
    company_name: Optional[str] = None
    contact_name: Optional[str] = None
    contact_title: Optional[str] = None
    product_pitch: Optional[str] = None
    objection: Optional[str] = None  # for objection response
    topic: Optional[str] = None  # for linkedin post
    tone: Optional[str] = None  # casual / professional / bold
    extra_notes: Optional[str] = None


class HistoryItem(BaseModel):
    id: str
    user_id: str
    type: str
    title: str
    input: Dict[str, Any]
    output: Dict[str, Any]
    saved: bool = False
    created_at: datetime


# ---------- Helpers ----------
async def _get_profile(user_id: str) -> Dict[str, Any]:
    doc = await db.users.find_one({"user_id": user_id}, {"_id": 0})
    return doc or {"user_id": user_id}


# ---------- Admin / Subscription helpers ----------
ADMIN_EMAILS = {e.strip().lower() for e in (os.environ.get("ADMIN_EMAILS") or "").split(",") if e.strip()}


async def _ensure_admin_flag(user_id: str, email: Optional[str]) -> bool:
    """Set is_admin=True on first login if the user's email is in ADMIN_EMAILS env."""
    if not email or not ADMIN_EMAILS:
        return False
    if email.strip().lower() in ADMIN_EMAILS:
        await db.users.update_one(
            {"user_id": user_id},
            {"$set": {"is_admin": True, "email": email, "user_id": user_id}},
            upsert=True,
        )
        return True
    return False


async def _require_admin(user_id: str) -> Dict[str, Any]:
    profile = await _get_profile(user_id)
    if not profile.get("is_admin"):
        # As a convenience, re-check email against env every call (handles env additions without re-login)
        if await _ensure_admin_flag(user_id, profile.get("email")):
            profile = await _get_profile(user_id)
    if not profile.get("is_admin"):
        raise HTTPException(status_code=403, detail="Admin only")
    return profile


def _has_active_entitlement(profile: Dict[str, Any]) -> bool:
    """Return True if user has paid sub OR admin-granted comp that hasn't expired."""
    now = datetime.now(timezone.utc)
    # Admin comp wins
    ac = profile.get("admin_comp_until")
    if isinstance(ac, str):
        try: ac = datetime.fromisoformat(ac.replace("Z", "+00:00"))
        except Exception: ac = None
    if ac and ac > now:
        return True
    # Paid subscription
    if profile.get("subscription_tier") in ("pro", "enterprise"):
        exp = profile.get("subscription_expires_at")
        if isinstance(exp, str):
            try: exp = datetime.fromisoformat(exp.replace("Z", "+00:00"))
            except Exception: exp = None
        if exp is None or exp > now:
            return True
    return False


def _entitlement_summary(profile: Dict[str, Any]) -> Dict[str, Any]:
    """Lightweight summary to return alongside profile so the client can paywall correctly."""
    now = datetime.now(timezone.utc)
    ac = profile.get("admin_comp_until")
    if isinstance(ac, str):
        try: ac = datetime.fromisoformat(ac.replace("Z", "+00:00"))
        except Exception: ac = None
    exp = profile.get("subscription_expires_at")
    if isinstance(exp, str):
        try: exp = datetime.fromisoformat(exp.replace("Z", "+00:00"))
        except Exception: exp = None
    is_comped = bool(ac and ac > now)
    is_paid = profile.get("subscription_tier") in ("pro", "enterprise") and (exp is None or exp > now)
    return {
        "is_admin": bool(profile.get("is_admin")),
        "tier": profile.get("subscription_tier") or "free",
        "source": "admin_comp" if is_comped else (profile.get("subscription_source") or "none"),
        "active": is_paid or is_comped,
        "expires_at": (ac if is_comped else exp).isoformat() if (ac if is_comped else exp) else None,
        "note": profile.get("admin_comp_note") if is_comped else None,
    }


async def _get_active_company(user_id: str) -> Optional[Dict[str, Any]]:
    profile = await _get_profile(user_id)
    company_id = profile.get("active_company_id")
    if company_id:
        c = await db.companies.find_one({"id": company_id, "user_id": user_id}, {"_id": 0})
        if c:
            return c
    # Fallback: any company belonging to the user (most recent)
    c = await db.companies.find_one({"user_id": user_id}, {"_id": 0}, sort=[("created_at", -1)])
    if c and not profile.get("active_company_id"):
        await db.users.update_one({"user_id": user_id}, {"$set": {"active_company_id": c["id"], "user_id": user_id}}, upsert=True)
    return c


async def _ensure_company_from_legacy(user_id: str) -> Optional[Dict[str, Any]]:
    """If the user has legacy profile.company_name but no Company records, migrate."""
    existing = await db.companies.find_one({"user_id": user_id}, {"_id": 0})
    if existing:
        return existing
    profile = await _get_profile(user_id)
    if not profile.get("company_name"):
        return None
    company = {
        "id": str(uuid.uuid4()),
        "user_id": user_id,
        "name": profile.get("company_name"),
        "website": profile.get("company_website"),
        "offerings": profile.get("company_offerings"),
        "value_props": profile.get("company_value_props"),
        "industry": profile.get("industry"),
        "target_audience": profile.get("target_audience"),
        "guidelines_text": profile.get("guidelines_text"),
        "created_at": datetime.now(timezone.utc).isoformat(),
    }
    await db.companies.insert_one(dict(company))
    await db.users.update_one({"user_id": user_id}, {"$set": {"active_company_id": company["id"]}}, upsert=True)
    return company


def _extract_json(text: str) -> Any:
    """Extract a JSON object/array from an LLM response.
    Tries straight parse, then with code-fence stripping, then a best-effort
    repair for the common case of unescaped double quotes inside string values.
    """
    raw = text.strip()
    # Strip code fences
    cleaned = re.sub(r"^```(?:json)?\s*", "", raw)
    cleaned = re.sub(r"\s*```$", "", cleaned)
    try:
        return json.loads(cleaned)
    except Exception:
        pass
    # Locate the JSON block
    match = re.search(r"(\{.*\}|\[.*\])", cleaned, re.S)
    block = match.group(1) if match else cleaned
    try:
        return json.loads(block)
    except Exception:
        pass
    # Best-effort repair: replace inner unescaped double quotes inside string
    # values with curly quotes. We walk character by character respecting
    # backslash escapes and brace/array nesting.
    repaired_chars: list[str] = []
    in_string = False
    escape = False
    i = 0
    n = len(block)
    while i < n:
        ch = block[i]
        if escape:
            repaired_chars.append(ch)
            escape = False
            i += 1
            continue
        if ch == "\\":
            repaired_chars.append(ch)
            escape = True
            i += 1
            continue
        if ch == '"':
            if not in_string:
                in_string = True
                repaired_chars.append(ch)
            else:
                # Look ahead: if next non-space char is one of `,:}]` or end,
                # this is the real closing quote. Otherwise treat as inner quote.
                j = i + 1
                while j < n and block[j] in " \t\r\n":
                    j += 1
                if j >= n or block[j] in ",:}]":
                    in_string = False
                    repaired_chars.append(ch)
                else:
                    repaired_chars.append("\u201d")
            i += 1
            continue
        repaired_chars.append(ch)
        i += 1
    repaired = "".join(repaired_chars)
    return json.loads(repaired)


async def _llm_generate_json(system_msg: str, user_msg: str) -> Any:
    chat = LlmChat(
        api_key=EMERGENT_LLM_KEY,
        session_id=f"repready-{uuid.uuid4()}",
        system_message=system_msg,
    ).with_model("anthropic", CLAUDE_MODEL).with_params(max_tokens=3500)

    response = await chat.send_message(UserMessage(text=user_msg))
    try:
        return _extract_json(response)
    except Exception as e:
        logger.error(f"JSON parse failed: {e}; raw={response[:500]}")
        raise HTTPException(status_code=502, detail="LLM did not return valid JSON")


def _profile_context(profile: Dict[str, Any], company: Optional[Dict[str, Any]] = None) -> str:
    parts = []
    if profile.get("role"):
        parts.append(f"Sales Role: {profile['role']}")
    # Prefer company-level data when present
    c = company or {}
    industry = c.get("industry") or profile.get("industry")
    audience = c.get("target_audience") or profile.get("target_audience")
    if industry:
        parts.append(f"Industry: {industry}")
    name = c.get("name") or profile.get("company_name")
    website = c.get("website") or profile.get("company_website")
    offerings = c.get("offerings") or profile.get("company_offerings")
    value_props = c.get("value_props") or profile.get("company_value_props")
    guidelines = c.get("guidelines_text") or profile.get("guidelines_text")
    if name:
        parts.append(f"Company: {name}")
    if website:
        parts.append(f"Website: {website}")
    if offerings:
        parts.append(f"What the company sells / offerings:\n{offerings[:1500]}")
    if value_props:
        parts.append(f"Key value props / differentiators:\n{value_props[:1000]}")
    if audience:
        parts.append(f"Target Audience: {audience}")
    if guidelines:
        parts.append(f"Brand voice & guidelines:\n{guidelines[:1500]}")
    if not parts:
        return "No profile context provided."
    return (
        "Use the following as ground truth for the rep's company. Never invent products "
        "or capabilities that aren't supported by these notes.\n" + "\n".join(parts)
    )


async def _save_history(user_id: str, type_: str, title: str, input_: Dict, output: Dict) -> Dict:
    item = {
        "id": str(uuid.uuid4()),
        "user_id": user_id,
        "type": type_,
        "title": title,
        "input": input_,
        "output": output,
        "saved": False,
        "created_at": datetime.now(timezone.utc).isoformat(),
    }
    await db.history.insert_one(dict(item))
    # Trim history to last 100 per user
    return item


# ---------- Routes: Health ----------
@api_router.get("/")
async def root():
    return {"name": "RepReady API", "status": "ok"}


# ---------- Routes: Profile ----------
@api_router.get("/users/profile")
async def get_profile(user_id: str = Depends(get_user_id)):
    profile = await _get_profile(user_id)
    # Auto-seed admin flag from ADMIN_EMAILS env (idempotent)
    if profile.get("email") and not profile.get("is_admin"):
        if await _ensure_admin_flag(user_id, profile.get("email")):
            profile = await _get_profile(user_id)
    # Attach lightweight entitlement summary so the client knows tier + paywall state
    profile["entitlement"] = _entitlement_summary(profile)
    return profile


@api_router.put("/users/profile")
async def update_profile(payload: ProfileUpdate, user_id: str = Depends(get_user_id)):
    update = {k: v for k, v in payload.dict().items() if v is not None}
    update["updated_at"] = datetime.now(timezone.utc).isoformat()
    update["user_id"] = user_id
    await db.users.update_one({"user_id": user_id}, {"$set": update}, upsert=True)
    # Re-check admin status if email was just set/changed
    if payload.email:
        await _ensure_admin_flag(user_id, payload.email)
    profile = await _get_profile(user_id)
    profile["entitlement"] = _entitlement_summary(profile)
    return profile


@api_router.delete("/users/me")
async def delete_my_account(user_id: str = Depends(get_user_id)):
    """Permanently delete the caller's account and all associated user data.

    Required by Apple App Store Guideline 5.1.1(v). This deletes the user's
    documents across every collection we own. The Firebase Auth user itself
    is deleted client-side via `deleteUser()` right after this call succeeds.
    """
    import asyncio
    # Best-effort revoke Composio connections so third-party tokens don't linger.
    try:
        cur = db.connected_accounts.find({"user_id": user_id})
        async for acct in cur:
            conn_id = acct.get("connection_id")
            if conn_id:
                try:
                    client = _composio_client()
                    # Old SDKs expose .connected_accounts.delete; newer .connections.delete.
                    if hasattr(client, "connected_accounts") and hasattr(client.connected_accounts, "delete"):
                        await asyncio.to_thread(client.connected_accounts.delete, conn_id)
                    elif hasattr(client, "connections") and hasattr(client.connections, "delete"):
                        await asyncio.to_thread(client.connections.delete, conn_id)
                except Exception as ce:
                    logger.warning(f"Composio delete conn {conn_id} failed (non-fatal): {ce}")
    except Exception as e:
        logger.warning(f"Composio bulk revoke failed (non-fatal): {e}")

    # Wipe every collection that stores per-user data.
    collections = [
        "users",
        "companies",
        "history",
        "scheduled_posts",
        "connected_accounts",
        "public_images",  # public_images are hosted-image byproducts, key by user is `owner`
    ]
    deleted_counts: Dict[str, int] = {}
    for coll_name in collections:
        try:
            coll = getattr(db, coll_name)
            # `public_images` doesn't have a user_id field; skip cleanly (they auto-expire).
            if coll_name == "public_images":
                continue
            res = await coll.delete_many({"user_id": user_id})
            deleted_counts[coll_name] = int(getattr(res, "deleted_count", 0) or 0)
        except Exception as e:
            logger.warning(f"Deletion in {coll_name} failed for user {user_id}: {e}")
            deleted_counts[coll_name] = -1

    logger.info(f"Account deleted: user={user_id} counts={deleted_counts}")
    return {"success": True, "deleted": deleted_counts,
            "note": "User account wiped from backend. Client should now delete Firebase Auth user."}


# ---------- Routes: Legal documents (public, no auth) ----------
LEGAL_DOCS_DIR = Path("/app/app_store_assets")
LEGAL_HTML_WRAPPER = """<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>{title}</title>
<style>
:root {{ color-scheme: light dark; }}
body {{ font-family: -apple-system, system-ui, "Segoe UI", Roboto, sans-serif; max-width: 720px; margin: 0 auto; padding: 24px 20px 64px; line-height: 1.55; color: #1a1a1a; background: #fff; }}
@media (prefers-color-scheme: dark) {{ body {{ background: #0b0b0b; color: #eaeaea; }} a {{ color: #6ab0ff; }} }}
h1, h2, h3 {{ line-height: 1.25; }}
h1 {{ font-size: 28px; margin-top: 8px; }}
h2 {{ font-size: 20px; margin-top: 32px; border-bottom: 1px solid #eee2; padding-bottom: 4px; }}
h3 {{ font-size: 16px; margin-top: 20px; }}
p, li {{ font-size: 15px; }}
code {{ background: #f5f5f7; padding: 1px 4px; border-radius: 4px; }}
hr {{ border: 0; border-top: 1px solid #eee3; margin: 24px 0; }}
</style>
</head>
<body>
{body}
</body>
</html>
"""


def _render_legal_html(md_filename: str, title: str) -> str:
    import markdown as _md
    try:
        raw = (LEGAL_DOCS_DIR / md_filename).read_text(encoding="utf-8")
    except Exception:
        raw = f"# {title}\n\nDocument not available. Please contact team@coolgeek.me."
    body = _md.markdown(raw, extensions=["extra", "sane_lists", "toc"])
    return LEGAL_HTML_WRAPPER.format(title=title, body=body)


@api_router.get("/legal/privacy", response_class=Response)
async def legal_privacy_policy():
    html = _render_legal_html("03_privacy_policy.md", "Privacy Policy — SalesReady")
    return Response(content=html, media_type="text/html", headers={"Cache-Control": "public, max-age=3600"})


@api_router.get("/legal/terms", response_class=Response)
async def legal_terms_of_service():
    html = _render_legal_html("05_terms_of_service.md", "Terms of Service — SalesReady")
    return Response(content=html, media_type="text/html", headers={"Cache-Control": "public, max-age=3600"})


# ---------- Routes: Admin (entitlement comp management) ----------
class GrantCompRequest(BaseModel):
    email: str  # The target user's email (case-insensitive lookup)
    duration_days: Optional[int] = 365  # Default 1 year comp
    until: Optional[str] = None  # ISO datetime — overrides duration_days
    note: Optional[str] = None  # e.g. "Family", "Beta tester"
    tier: Optional[str] = "pro"  # "pro" or "enterprise"


@api_router.get("/admin/users")
async def admin_list_users(user_id: str = Depends(get_user_id)):
    """List all users with their entitlement summary."""
    await _require_admin(user_id)
    cur = db.users.find({}, {"_id": 0}).sort("updated_at", -1).limit(500)
    items = []
    async for u in cur:
        items.append({
            "user_id": u.get("user_id"),
            "email": u.get("email"),
            "display_name": u.get("display_name"),
            "is_admin": bool(u.get("is_admin")),
            "entitlement": _entitlement_summary(u),
        })
    return {"items": items, "admin_emails_env": sorted(ADMIN_EMAILS)}


@api_router.post("/admin/grant-comp")
async def admin_grant_comp(payload: GrantCompRequest, user_id: str = Depends(get_user_id)):
    """Grant a free 'admin comp' subscription to a user by email."""
    await _require_admin(user_id)
    if not payload.email:
        raise HTTPException(status_code=400, detail="email required")

    # Find user by email (case-insensitive)
    email_lower = payload.email.strip().lower()
    target = await db.users.find_one({"email": {"$regex": f"^{email_lower}$", "$options": "i"}}, {"_id": 0})
    if not target:
        raise HTTPException(status_code=404, detail=f"No user with email {payload.email}")

    # Compute the "until" timestamp
    if payload.until:
        try:
            until_dt = datetime.fromisoformat(payload.until.replace("Z", "+00:00"))
        except Exception:
            raise HTTPException(status_code=400, detail="until must be ISO datetime")
    else:
        days = payload.duration_days or 365
        until_dt = datetime.now(timezone.utc) + timedelta(days=days)

    tier = payload.tier or "pro"
    if tier not in ("pro", "enterprise"):
        raise HTTPException(status_code=400, detail="tier must be 'pro' or 'enterprise'")

    await db.users.update_one(
        {"user_id": target["user_id"]},
        {"$set": {
            "admin_comp_until": until_dt.isoformat(),
            "admin_comp_note": payload.note or f"Granted by {user_id}",
            "subscription_tier": tier,
            "subscription_source": "admin_comp",
            "updated_at": datetime.now(timezone.utc).isoformat(),
        }},
        upsert=False,
    )
    updated = await _get_profile(target["user_id"])
    return {
        "ok": True,
        "user_id": target["user_id"],
        "email": target.get("email"),
        "entitlement": _entitlement_summary(updated),
    }


@api_router.post("/admin/revoke-comp")
async def admin_revoke_comp(payload: GrantCompRequest, user_id: str = Depends(get_user_id)):
    """Revoke a previously granted comp (sets admin_comp_until to now, drops back to free)."""
    await _require_admin(user_id)
    email_lower = payload.email.strip().lower()
    target = await db.users.find_one({"email": {"$regex": f"^{email_lower}$", "$options": "i"}}, {"_id": 0})
    if not target:
        raise HTTPException(status_code=404, detail=f"No user with email {payload.email}")
    await db.users.update_one(
        {"user_id": target["user_id"]},
        {"$set": {
            "admin_comp_until": None,
            "admin_comp_note": None,
            "subscription_tier": "free",
            "subscription_source": "none",
            "updated_at": datetime.now(timezone.utc).isoformat(),
        }},
    )
    return {"ok": True, "user_id": target["user_id"], "email": target.get("email")}


# ---------- Routes: Generators ----------
async def _generate(user_id: str, type_: str, schema_hint: str, prompt: str, req: GenerateRequest, title: str) -> Dict:
    profile = await _get_profile(user_id)
    company = await _get_active_company(user_id) or await _ensure_company_from_legacy(user_id)
    context = _profile_context(profile, company)
    system = (
        "You are RepReady, an elite sales enablement assistant. You craft concise, "
        "high-conversion, human-sounding sales content. Avoid clichés, avoid hype. "
        "Always reply with strict, valid JSON only — no prose, no markdown fences. "
        "CRITICAL: When string values contain quotes, use single quotes (') or curly quotes "
        "(' ' \u201c \u201d) — never raw unescaped double quotes inside string values."
    )
    user_msg = f"""Sales rep context:
{context}

Task: {prompt}

Return strictly this JSON schema (no explanations):
{schema_hint}
"""
    output = await _llm_generate_json(system, user_msg)
    item = await _save_history(user_id, type_, title, req.dict(), {"data": output})
    return {
        "id": item["id"],
        "type": type_,
        "title": title,
        "output": output,
        "created_at": item["created_at"],
        "active_company": {"id": company.get("id"), "name": company.get("name")} if company else None,
    }


@api_router.post("/generate/cold-email")
async def generate_cold_email(req: GenerateRequest, user_id: str = Depends(get_user_id)):
    schema = '''{
  "variations": [
    {"subject": "string", "body": "string", "style": "string (e.g., direct, value-led, curiosity)"}
  ]
}'''
    prompt = (
        f"Write 3 cold email variations to {req.contact_name or 'a prospect'} "
        f"({req.contact_title or 'decision maker'}) at {req.company_name or 'their company'}. "
        f"Pitch: {req.product_pitch or 'our solution'}. "
        f"Tone: {req.tone or 'professional and warm'}. Extra notes: {req.extra_notes or 'none'}. "
        "Each variation must be under 120 words. Different angles."
    )
    title = f"Cold email • {req.company_name or 'Prospect'}"
    return await _generate(user_id, "cold_email", schema, prompt, req, title)


@api_router.post("/generate/objection-response")
async def generate_objection(req: GenerateRequest, user_id: str = Depends(get_user_id)):
    schema = '''{
  "objection": "string",
  "responses": [
    {"approach": "string (e.g., reframe, social proof, discovery)", "script": "string"}
  ]
}'''
    prompt = (
        f"Handle this sales objection: \"{req.objection or 'It is too expensive.'}\" "
        f"Context: pitch={req.product_pitch or 'our solution'}. "
        "Provide 3 distinct response approaches — each with a 2-4 sentence verbal script the rep can use."
    )
    title = f"Objection • {(req.objection or 'Objection')[:40]}"
    return await _generate(user_id, "objection", schema, prompt, req, title)


@api_router.post("/generate/call-script")
async def generate_call_script(req: GenerateRequest, user_id: str = Depends(get_user_id)):
    schema = '''{
  "openers": [{"label": "string", "script": "string"}],
  "discovery_questions": ["string"]
}'''
    prompt = (
        f"Create a discovery call script for {req.contact_name or 'a prospect'} at "
        f"{req.company_name or 'their company'}. Pitch: {req.product_pitch or 'our solution'}. "
        "Provide 2 distinct openers (each 2-3 sentences) and 3 sharp discovery questions that uncover pain."
    )
    title = f"Call script • {req.company_name or 'Discovery'}"
    return await _generate(user_id, "call_script", schema, prompt, req, title)


@api_router.post("/generate/company-intel")
async def generate_company_intel(req: GenerateRequest, user_id: str = Depends(get_user_id)):
    schema = '''{
  "company": "string",
  "personalization_hooks": [
    {"hook": "string (one-liner)", "why_it_works": "string", "use_in": "string (e.g., email opener)"}
  ],
  "likely_priorities": ["string"]
}'''
    prompt = (
        f"Generate personalization intel for outreach to {req.contact_name or 'the contact'} "
        f"({req.contact_title or 'decision maker'}) at {req.company_name or 'the target company'}. "
        "Produce 5 personalization hooks (plausible, sales-friendly) and 3 likely current priorities. "
        "Mark each hook as speculative — do NOT fabricate specific verifiable facts. Use industry-typical patterns."
    )
    title = f"Intel • {req.company_name or 'Company'}"
    return await _generate(user_id, "company_intel", schema, prompt, req, title)


@api_router.post("/generate/re-engagement")
async def generate_reengagement(req: GenerateRequest, user_id: str = Depends(get_user_id)):
    schema = '''{
  "angles": [
    {"angle": "string (e.g., new feature, fresh stat, value-add)", "subject": "string", "body": "string"}
  ]
}'''
    prompt = (
        f"Generate 3 re-engagement follow-up messages to a cold prospect "
        f"{req.contact_name or ''} at {req.company_name or 'their company'}. "
        f"Original pitch: {req.product_pitch or 'our solution'}. "
        "Each angle must be different, under 90 words, and feel non-pushy."
    )
    title = f"Re-engage • {req.company_name or 'Prospect'}"
    return await _generate(user_id, "re_engagement", schema, prompt, req, title)


@api_router.post("/generate/linkedin-post")
async def generate_linkedin_post(req: GenerateRequest, user_id: str = Depends(get_user_id)):
    schema = '''{
  "variations": [
    {"hook": "string", "body": "string", "hashtags": ["string"]}
  ]
}'''
    prompt = (
        f"Write 2 LinkedIn post variations for a sales rep about: {req.topic or 'building authentic pipeline'}. "
        f"Tone: {req.tone or 'authentic and confident'}. "
        "Each post: scroll-stopping first line, 4-7 short lines, and 3-5 relevant hashtags. No generic motivational fluff."
    )
    title = f"LinkedIn • {(req.topic or 'Post')[:40]}"
    return await _generate(user_id, "linkedin_post", schema, prompt, req, title)


# ---------- Routes: History ----------
@api_router.get("/history")
async def list_history(user_id: str = Depends(get_user_id), saved_only: bool = False):
    query: Dict[str, Any] = {"user_id": user_id}
    if saved_only:
        query["saved"] = True
    items = await db.history.find(query, {"_id": 0}).sort("created_at", -1).to_list(100)
    return {"items": items}


@api_router.post("/history/{item_id}/save")
async def toggle_save(item_id: str, user_id: str = Depends(get_user_id)):
    doc = await db.history.find_one({"id": item_id, "user_id": user_id}, {"_id": 0})
    if not doc:
        raise HTTPException(status_code=404, detail="Not found")
    new_saved = not doc.get("saved", False)
    await db.history.update_one({"id": item_id, "user_id": user_id}, {"$set": {"saved": new_saved}})
    return {"id": item_id, "saved": new_saved}


@api_router.delete("/history/{item_id}")
async def delete_history(item_id: str, user_id: str = Depends(get_user_id)):
    res = await db.history.delete_one({"id": item_id, "user_id": user_id})
    return {"deleted": res.deleted_count}


# ---------- Routes: Daily Prompt ----------
@api_router.get("/daily-prompt")
async def daily_prompt(user_id: str = Depends(get_user_id)):
    profile = await _get_profile(user_id)
    today = datetime.now(timezone.utc).strftime("%A, %b %d")
    schema = '''{"focus": "string (one-liner)", "action_steps": ["string", "string", "string"], "quote": "string"}'''
    system = (
        "You are RepReady. Generate today's quick daily sales focus. "
        "Reply with strict JSON only. No markdown."
    )
    user_msg = (
        f"Today: {today}. Rep profile: role={profile.get('role') or 'AE'}, "
        f"industry={profile.get('industry') or 'SaaS'}. "
        "Output one sharp focus theme (max 12 words), 3 micro action steps (max 10 words each), and a short relevant quote.\n\n"
        f"Return strictly this JSON schema (no explanations, no markdown):\n{schema}"
    )
    data = await _llm_generate_json(system, user_msg)
    return {"date": today, **data}


# ---------- Routes: Company autofill ----------
class CompanyAutofillRequest(BaseModel):
    company_name: str
    company_website: Optional[str] = None


def _normalize_url(url: str) -> str:
    url = url.strip()
    if not url:
        return ""
    if not url.startswith(("http://", "https://")):
        url = "https://" + url
    return url


async def _fetch_site_text(url: str) -> str:
    """Fetch a URL and return cleaned visible text (up to ~6000 chars)."""
    headers = {
        "User-Agent": "Mozilla/5.0 (compatible; RepReadyBot/1.0; +https://repready.app)",
        "Accept": "text/html,application/xhtml+xml",
    }
    async with httpx.AsyncClient(timeout=12.0, follow_redirects=True, headers=headers) as client:
        resp = await client.get(url)
        resp.raise_for_status()
        html = resp.text
    # Strip script/style/nav/footer blocks, then tags
    html = re.sub(r"<(script|style|noscript)[^>]*>.*?</\1>", " ", html, flags=re.S | re.I)
    html = re.sub(r"<!--.*?-->", " ", html, flags=re.S)
    text = re.sub(r"<[^>]+>", " ", html)
    text = re.sub(r"&nbsp;|&#160;", " ", text)
    text = re.sub(r"&amp;", "&", text)
    text = re.sub(r"&lt;", "<", text)
    text = re.sub(r"&gt;", ">", text)
    text = re.sub(r"&quot;", '"', text)
    text = re.sub(r"\s+", " ", text).strip()
    return text[:6000]


@api_router.post("/company/autofill")
async def company_autofill(payload: CompanyAutofillRequest, user_id: str = Depends(get_user_id)):
    name = payload.company_name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="company_name is required")

    site_text = ""
    site_error: Optional[str] = None
    if payload.company_website:
        try:
            site_text = await _fetch_site_text(_normalize_url(payload.company_website))
        except Exception as e:
            site_error = f"Could not fetch site: {type(e).__name__}"
            logger.warning(f"Autofill fetch failed for {payload.company_website}: {e}")

    schema = '''{
  "company_offerings": "string (2-4 sentences plain text)",
  "company_value_props": "string (3-5 dashed bullet lines separated by \\n)",
  "industry": "string (one of: SaaS, FinTech, Healthcare, Manufacturing, Education, E-commerce, Real Estate, Marketing, or a short custom label)",
  "target_audience": "string (one-line ICP, e.g., 'VPs of Engineering at mid-market SaaS')",
  "source_confidence": "string (high|medium|low)"
}'''

    system = (
        "You are RepReady, a B2B sales research assistant. Build a clean sales-ready "
        "company brief from the inputs. Use ONLY information evidenced by the website "
        "text when provided. If a field is uncertain or the site is missing, mark "
        "source_confidence as 'low' and produce a plausible best-effort guess based "
        "on the company name. Never fabricate specific numbers, customer logos, or "
        "compliance certifications. Reply with strict JSON only, no markdown."
    )

    user_msg_parts = [f"Company name: {name}"]
    if payload.company_website:
        user_msg_parts.append(f"Website: {payload.company_website}")
    if site_text:
        user_msg_parts.append(f"\nWebsite text (cleaned, truncated):\n{site_text}")
    elif site_error:
        user_msg_parts.append(f"\n(Note: {site_error}. Use only the company name.)")
    user_msg_parts.append(f"\nReturn strictly this JSON schema (no explanations):\n{schema}")

    data = await _llm_generate_json(system, "\n".join(user_msg_parts))
    return {
        "company_name": name,
        "company_website": payload.company_website or "",
        "fetched_site": bool(site_text),
        "site_error": site_error,
        **data,
    }


# ---------- Routes: Image generation (Gemini Nano Banana) ----------
class ImageRequest(BaseModel):
    hook: Optional[str] = None
    body: Optional[str] = None
    prompt: Optional[str] = None  # explicit override
    style: Optional[str] = None  # e.g., "minimal flat illustration"


@api_router.post("/generate/post-image")
async def generate_post_image(payload: ImageRequest, user_id: str = Depends(get_user_id)):
    profile = await _get_profile(user_id)
    company = await _get_active_company(user_id) or await _ensure_company_from_legacy(user_id)
    industry = (company.get("industry") if company else None) or profile.get("industry") or "business"
    style = payload.style or "modern editorial photo, soft natural light, shallow depth of field, professional, high contrast"

    if payload.prompt:
        image_prompt = payload.prompt
    else:
        seed = f"{payload.hook or ''}. {payload.body or ''}".strip()[:600]
        image_prompt = (
            f"A scroll-stopping LinkedIn post hero image for a {industry} professional. "
            f"Concept: {seed}. "
            f"Style: {style}. No on-image text or watermarks. "
            "Square 1:1 aspect ratio, social-media optimized."
        )

    chat = LlmChat(
        api_key=EMERGENT_LLM_KEY,
        session_id=f"repready-img-{uuid.uuid4()}",
        system_message="You generate a single high-quality social media image based on the user's brief.",
    ).with_model("gemini", "gemini-3.1-flash-image-preview").with_params(modalities=["image", "text"])

    try:
        _, images = await chat.send_message_multimodal_response(UserMessage(text=image_prompt))
    except Exception as e:
        logger.error(f"Image gen failed: {e}")
        raise HTTPException(status_code=502, detail="Image generation failed")

    if not images:
        raise HTTPException(status_code=502, detail="No image returned")

    img = images[0]
    return {
        "mime_type": img.get("mime_type", "image/png"),
        "data": img.get("data"),  # base64 string
        "prompt": image_prompt,
    }


SOCIAL_POST_TOOLS: Dict[str, Dict[str, Any]] = {
    "linkedin": {
        "slug": "LINKEDIN_CREATE_LINKED_IN_POST",
        # Built dynamically per-call because LinkedIn requires the author URN
        "needs_image": False,
    },
    "facebook": {
        # Text-only slug; photo posts use FACEBOOK_CREATE_PHOTO_POST instead.
        "slug": "FACEBOOK_CREATE_POST",
        "needs_image": False,
    },
    "instagram": {
        # Note: Instagram is a TWO-PHASE flow (container -> publish). The slug here is
        # the publish step; we orchestrate INSTAGRAM_CREATE_MEDIA_CONTAINER first.
        "slug": "INSTAGRAM_CREATE_POST",
        "needs_image": True,
    },
}


def _extract_first(d: Any, keys: List[str]) -> Optional[Any]:
    """Walk a Composio response and return the first non-empty value found under one of `keys`."""
    if d is None:
        return None
    if isinstance(d, dict):
        for k in keys:
            if k in d and d[k] not in (None, "", []):
                return d[k]
        for v in d.values():
            r = _extract_first(v, keys)
            if r:
                return r
    elif isinstance(d, list):
        for item in d:
            r = _extract_first(item, keys)
            if r:
                return r
    return None


def _composio_to_dict(result: Any) -> Dict[str, Any]:
    """Convert a Composio ToolExecuteResponse (or dict) into a plain dict for parsing."""
    if isinstance(result, dict):
        return result
    out: Dict[str, Any] = {}
    for attr in ("data", "error", "successful", "logs"):
        try:
            v = getattr(result, attr, None)
            if v is not None:
                out[attr] = v
        except Exception:
            pass
    return out


async def _composio_call(user_id: str, slug: str, arguments: Dict[str, Any], connected_account_id: Optional[str] = None) -> Dict[str, Any]:
    """Run a Composio tool call and return a normalized dict {success, data, error_raw}.
    The SDK raises BadRequestError / other exceptions on failure; we trap them and
    surface a uniform success:false shape so callers never have to try/except.
    """
    import asyncio
    def _exec():
        client = _composio_client()
        kwargs: Dict[str, Any] = {
            "user_id": user_id,
            "slug": slug,
            "arguments": arguments,
            "dangerously_skip_version_check": True,
        }
        if connected_account_id:
            kwargs["connected_account_id"] = connected_account_id
        return client.tools.execute(**kwargs)
    try:
        result = await asyncio.to_thread(_exec)
    except Exception as e:
        return {"success": False, "data": None, "error_raw": e, "raw": None}
    norm = _composio_to_dict(result)
    successful = norm.get("successful")
    if successful is None:
        successful = True
    err = norm.get("error") if not successful else None
    return {"success": bool(successful), "data": norm.get("data"), "error_raw": err if not successful else None, "raw": result}


async def _instagram_get_user_id(user_id: str, connected_account_id: Optional[str] = None) -> Dict[str, Any]:
    """Return (and cache) the Instagram Business/Creator account ID for the user.
    Returns {"id": str|None, "error": str|None} so callers can surface the right reason
    (e.g. distinguish "no account connected" from "Business account missing").
    """
    cache_key = connected_account_id or "_default"
    user_doc = await db.users.find_one({"user_id": user_id}) or {}
    cached = ((user_doc.get("instagram_user_ids") or {}).get(cache_key))
    if cached:
        return {"id": cached, "error": None}

    # Discover (single primary slug; fallbacks removed since the SDK reliably exposes this one).
    res = await _composio_call(user_id, "INSTAGRAM_GET_USER_INFO", {}, connected_account_id=connected_account_id)
    if not res["success"]:
        logger.error(f"Instagram user discovery failed: {res.get('error_raw')}")
        return {"id": None, "error": str(res.get("error_raw") or "")}

    ig_id = _extract_first(res["data"], ["ig_user_id", "instagram_business_account_id", "instagram_id", "user_id", "id"])
    if not ig_id:
        logger.error(f"Instagram user_id not found in response: {res['data']}")
        return {"id": None, "error": "no_business_account"}
    ig_id = str(ig_id)
    await db.users.update_one(
        {"user_id": user_id},
        {"$set": {f"instagram_user_ids.{cache_key}": ig_id, "user_id": user_id}},
        upsert=True,
    )
    return {"id": ig_id, "error": None}


async def _facebook_get_page_id(user_id: str, connected_account_id: Optional[str] = None) -> Dict[str, Any]:
    """Return (and cache) the user's first managed Facebook Page ID.
    Returns {"id": str|None, "error": str|None}.
    """
    cache_key = connected_account_id or "_default"
    user_doc = await db.users.find_one({"user_id": user_id}) or {}
    cached = ((user_doc.get("facebook_page_ids") or {}).get(cache_key))
    if cached:
        return {"id": cached, "error": None}

    res = await _composio_call(user_id, "FACEBOOK_LIST_MANAGED_PAGES", {}, connected_account_id=connected_account_id)
    if not res["success"]:
        logger.error(f"Facebook page discovery failed: {res.get('error_raw')}")
        return {"id": None, "error": str(res.get("error_raw") or "")}

    page_id: Optional[Any] = None
    data = res["data"]
    if isinstance(data, dict):
        for key in ("data", "pages", "items", "result"):
            if isinstance(data.get(key), list) and data[key]:
                page_id = data[key][0].get("id") if isinstance(data[key][0], dict) else None
                if page_id:
                    break
        if not page_id:
            page_id = data.get("id") or data.get("page_id")
    elif isinstance(data, list) and data:
        first = data[0]
        if isinstance(first, dict):
            page_id = first.get("id") or first.get("page_id")
    if not page_id:
        page_id = _extract_first(data, ["page_id", "id"])
    if not page_id:
        logger.error(f"Facebook page_id not found in response: {data}")
        return {"id": None, "error": "no_managed_page"}
    page_id = str(page_id)
    await db.users.update_one(
        {"user_id": user_id},
        {"$set": {f"facebook_page_ids.{cache_key}": page_id, "user_id": user_id}},
        upsert=True,
    )
    return {"id": page_id, "error": None}


def _build_post_args(platform: str, content: str, image_url: Optional[str], author_urn: Optional[str]) -> Dict[str, Any]:
    """Legacy helper kept for the scheduler/back-compat. New code should call the
    posting helpers directly which handle platform-specific multi-step flows.
    """
    if platform == "linkedin":
        return {"author": author_urn or "", "commentary": content}
    if platform == "facebook":
        # message is the Graph API field; some Composio tools alias as `text` but `message` is canonical.
        return {"message": content}
    if platform == "instagram":
        return {"caption": content, "image_url": image_url or ""}
    return {}


async def _linkedin_upload_image(user_id: str, author_urn: str, image_b64: str, mimetype: str) -> Dict[str, str]:
    """Upload a base64 image into Composio's S3 so it can be referenced as a
    LinkedIn post attachment via the file_uploadable schema. Returns the
    image attachment dict expected by LINKEDIN_CREATE_LINKED_IN_POST.
    """
    import asyncio, base64, tempfile, os
    from composio.core.models._files import FileUploadable

    ext = "jpg" if "jpeg" in (mimetype or "") else ((mimetype or "image/png").split("/")[-1] or "png")
    img_bytes = base64.b64decode(image_b64)

    def _do_upload() -> Dict[str, str]:
        tmp_path = None
        try:
            with tempfile.NamedTemporaryFile(suffix=f".{ext}", delete=False) as f:
                f.write(img_bytes)
                tmp_path = f.name
            client = _composio_client()
            fu = FileUploadable.from_path(
                client=client.client,
                file=tmp_path,
                tool="LINKEDIN_CREATE_LINKED_IN_POST",
                toolkit="LINKEDIN",
                file_upload_allowlist=None,
            )
            return {"name": f"repready-post.{ext}", "mimetype": fu.mimetype, "s3key": fu.s3key}
        finally:
            if tmp_path and os.path.exists(tmp_path):
                try:
                    os.unlink(tmp_path)
                except Exception:
                    pass

    return await asyncio.to_thread(_do_upload)


async def _linkedin_get_author_urn(user_id: str) -> str:
    """Return cached LinkedIn person URN or fetch via LINKEDIN_GET_MY_INFO."""
    profile = await _get_profile(user_id)
    cached = profile.get("linkedin_author_urn")
    if cached:
        return cached
    import asyncio
    def _call():
        client = _composio_client()
        return client.tools.execute(
            user_id=user_id,
            slug="LINKEDIN_GET_MY_INFO",
            arguments={},
            dangerously_skip_version_check=True,
        )
    result = await asyncio.to_thread(_call)
    # Result shape: {data: {..., id: '...', sub: '...'}} or pydantic model
    data: Any = None
    try:
        if hasattr(result, "data"):
            data = result.data
        elif isinstance(result, dict):
            data = result.get("data") or result
    except Exception:
        data = result
    # Try multiple known keys for the person identifier
    person_id = None
    if isinstance(data, dict):
        person_id = data.get("id") or data.get("sub") or data.get("response_data", {}).get("id")
    if not person_id:
        raise HTTPException(status_code=502, detail="Could not retrieve LinkedIn profile ID. Reconnect LinkedIn.")
    author_urn = f"urn:li:person:{person_id}"
    await db.users.update_one(
        {"user_id": user_id},
        {"$set": {"linkedin_author_urn": author_urn, "user_id": user_id}},
        upsert=True,
    )
    return author_urn


def _build_post_args(platform: str, content: str, image_url: Optional[str], author_urn: Optional[str]) -> Dict[str, Any]:
    if platform == "linkedin":
        return {"author": author_urn or "", "commentary": content}
    if platform == "facebook":
        args: Dict[str, Any] = {"text": content}
        if image_url:
            # FACEBOOK_CREATE_POST accepts an optional photo URL field
            args["url"] = image_url
        return args
    if platform == "instagram":
        return {"caption": content, "image_url": image_url or ""}
    return {}


# ---------- Public image hosting (so Instagram/Facebook can fetch HTTPS images) ----------
def _resolve_public_base(request: Optional[Request]) -> str:
    """Return the canonical public HTTPS base URL for this backend.
    Priority: PUBLIC_BACKEND_URL env var > x-forwarded headers > request.url base.
    """
    base = (os.environ.get("PUBLIC_BACKEND_URL") or "").strip().rstrip("/")
    if base:
        return base
    if request is not None:
        proto = request.headers.get("x-forwarded-proto") or request.url.scheme or "https"
        host = request.headers.get("x-forwarded-host") or request.url.netloc
        if host:
            return f"{proto}://{host}".rstrip("/")
    # Last resort fallback - won't work for Instagram, but doesn't crash
    return ""


async def _host_public_image(image_b64: str, image_mime: str, request: Optional[Request]) -> str:
    """Store a base64 image as a temporary public asset and return its HTTPS URL.
    The asset is valid for 2 hours and is served by GET /api/public/social-image/{id}.
    Returns an empty string if no public base URL is resolvable.
    """
    try:
        # Strip data-URI prefix if accidentally present
        if image_b64 and image_b64.startswith("data:") and "," in image_b64:
            head, image_b64 = image_b64.split(",", 1)
            if "image/" in head:
                image_mime = head.split(":")[1].split(";")[0]
        img_bytes = base64.b64decode(image_b64)
    except Exception as e:
        logger.warning(f"_host_public_image: failed to decode b64: {e}")
        return ""
    base = _resolve_public_base(request)
    if not base:
        return ""
    img_id = secrets.token_urlsafe(16)
    now = datetime.now(timezone.utc)
    expires_at = now + timedelta(hours=2)
    try:
        # Store expires_at as ISO string for tz-safe comparisons (motor returns naive datetimes by default)
        await db.public_images.insert_one({
            "id": img_id,
            "data": img_bytes,
            "mime": (image_mime or "image/png"),
            "created_at": now.isoformat(),
            "expires_at": expires_at.isoformat(),
        })
    except Exception as e:
        logger.error(f"_host_public_image: insert failed: {e}")
        return ""
    return f"{base}/api/public/social-image/{img_id}"


# Public (no auth) image serving route. Mounted on api_router so it goes through /api.
@api_router.get("/public/social-image/{img_id}")
async def get_public_social_image(img_id: str):
    doc = await db.public_images.find_one({"id": img_id})
    if not doc:
        raise HTTPException(status_code=404, detail="Not found")
    exp = doc.get("expires_at")
    expired = False
    if isinstance(exp, str):
        try:
            exp_dt = datetime.fromisoformat(exp.replace("Z", "+00:00"))
            if exp_dt.tzinfo is None:
                exp_dt = exp_dt.replace(tzinfo=timezone.utc)
            expired = exp_dt < datetime.now(timezone.utc)
        except Exception:
            expired = False
    elif isinstance(exp, datetime):
        # Defensive: normalize naive datetimes (motor default) to UTC
        if exp.tzinfo is None:
            exp = exp.replace(tzinfo=timezone.utc)
        expired = exp < datetime.now(timezone.utc)
    if expired:
        try:
            await db.public_images.delete_one({"id": img_id})
        except Exception:
            pass
        raise HTTPException(status_code=410, detail="Expired")
    raw = doc.get("data") or b""
    if isinstance(raw, str):
        # Defensive: if stored as base64 string for any reason
        try:
            raw = base64.b64decode(raw)
        except Exception:
            pass
    mime = doc.get("mime") or "image/png"
    return Response(content=raw, media_type=mime, headers={"Cache-Control": "public, max-age=3600"})


@api_router.post("/generate/topic-ideas")
async def generate_topic_ideas(payload: Dict[str, Any], user_id: str = Depends(get_user_id)):
    profile = await _get_profile(user_id)
    company = await _get_active_company(user_id) or await _ensure_company_from_legacy(user_id)
    context = _profile_context(profile, company)
    angle = (payload.get("angle") or "").strip()
    schema = '''{
  "topics": [
    {"topic": "string (8-14 word post angle)", "why": "string (one-line: why this resonates)", "tag": "string (e.g., story, lesson, hot take, customer win, contrarian)"}
  ]
}'''
    system = (
        "You are RepReady. Generate scroll-stopping LinkedIn post topic ideas for the sales rep. "
        "Make them SPECIFIC, tied to their company offerings and target audience. "
        "Avoid generic motivational fluff. Reply with strict JSON only."
    )
    user_msg = (
        f"Rep context:\n{context}\n\n"
        f"Optional angle filter: {angle or 'mix of story, lesson, customer win, hot take, and tactical advice'}.\n"
        "Generate 6 distinct, specific topic ideas the rep could post about this week.\n"
        f"Return strictly this JSON:\n{schema}"
    )
    data = await _llm_generate_json(system, user_msg)
    if isinstance(data, dict):
        data["active_company"] = {"id": company.get("id"), "name": company.get("name")} if company else None
    return data


# ---------- Routes: Companies (multi-business) ----------
@api_router.get("/companies")
async def list_companies(user_id: str = Depends(get_user_id)):
    await _ensure_company_from_legacy(user_id)
    items = await db.companies.find({"user_id": user_id}, {"_id": 0}).sort("created_at", -1).to_list(50)
    profile = await _get_profile(user_id)
    return {"items": items, "active_id": profile.get("active_company_id")}


@api_router.post("/companies")
async def create_company(payload: CompanyIn, user_id: str = Depends(get_user_id)):
    if not payload.name.strip():
        raise HTTPException(status_code=400, detail="name is required")
    company = {
        "id": str(uuid.uuid4()),
        "user_id": user_id,
        "name": payload.name.strip(),
        "website": payload.website,
        "offerings": payload.offerings,
        "value_props": payload.value_props,
        "industry": payload.industry,
        "target_audience": payload.target_audience,
        "guidelines_text": payload.guidelines_text,
        "created_at": datetime.now(timezone.utc).isoformat(),
    }
    await db.companies.insert_one(dict(company))
    profile = await _get_profile(user_id)
    if not profile.get("active_company_id"):
        await db.users.update_one({"user_id": user_id}, {"$set": {"active_company_id": company["id"], "user_id": user_id}}, upsert=True)
    return company


@api_router.put("/companies/{company_id}")
async def update_company(company_id: str, payload: CompanyIn, user_id: str = Depends(get_user_id)):
    update = {k: v for k, v in payload.dict().items() if v is not None}
    res = await db.companies.update_one({"id": company_id, "user_id": user_id}, {"$set": update})
    if res.matched_count == 0:
        raise HTTPException(status_code=404, detail="Company not found")
    return await db.companies.find_one({"id": company_id, "user_id": user_id}, {"_id": 0})


@api_router.delete("/companies/{company_id}")
async def delete_company(company_id: str, user_id: str = Depends(get_user_id)):
    res = await db.companies.delete_one({"id": company_id, "user_id": user_id})
    profile = await _get_profile(user_id)
    if profile.get("active_company_id") == company_id:
        next_c = await db.companies.find_one({"user_id": user_id}, {"_id": 0}, sort=[("created_at", -1)])
        await db.users.update_one({"user_id": user_id}, {"$set": {"active_company_id": next_c["id"] if next_c else None}}, upsert=True)
    return {"deleted": res.deleted_count}


@api_router.post("/companies/{company_id}/activate")
async def activate_company(company_id: str, user_id: str = Depends(get_user_id)):
    c = await db.companies.find_one({"id": company_id, "user_id": user_id}, {"_id": 0})
    if not c:
        raise HTTPException(status_code=404, detail="Company not found")
    await db.users.update_one({"user_id": user_id}, {"$set": {"active_company_id": company_id, "user_id": user_id}}, upsert=True)
    return {"active_id": company_id}


# ---------- Routes: Scheduled Posts ----------
@api_router.post("/scheduled")
async def schedule_post(payload: ScheduledPostIn, user_id: str = Depends(get_user_id)):
    try:
        sched_dt = datetime.fromisoformat(payload.scheduled_for.replace("Z", "+00:00"))
    except Exception:
        raise HTTPException(status_code=400, detail="scheduled_for must be ISO datetime")
    item = {
        "id": str(uuid.uuid4()),
        "user_id": user_id,
        "content": payload.content,
        "platforms": payload.platforms,
        "image_b64": payload.image_b64,
        "image_mime": payload.image_mime,
        "history_id": payload.history_id,
        "scheduled_for": sched_dt.isoformat(),
        "status": "scheduled",
        "created_at": datetime.now(timezone.utc).isoformat(),
        "results": [],
    }
    await db.scheduled_posts.insert_one(dict(item))
    return {k: v for k, v in item.items() if k != "image_b64"}


@api_router.get("/scheduled")
async def list_scheduled(user_id: str = Depends(get_user_id)):
    items = await db.scheduled_posts.find(
        {"user_id": user_id},
        {"_id": 0, "image_b64": 0},
    ).sort("scheduled_for", 1).to_list(100)
    return {"items": items}


@api_router.delete("/scheduled/{sched_id}")
async def cancel_scheduled(sched_id: str, user_id: str = Depends(get_user_id)):
    res = await db.scheduled_posts.delete_one({"id": sched_id, "user_id": user_id, "status": "scheduled"})
    return {"deleted": res.deleted_count}


# ---------- Routes: Composio Social (LinkedIn / Facebook / Instagram) ----------
def _composio_client():
    from composio import Composio
    return Composio(api_key=COMPOSIO_API_KEY)


def _require_social_config(platform: str) -> str:
    auth_config_id = SOCIAL_AUTH_CONFIGS.get(platform, "")
    if not auth_config_id:
        raise HTTPException(
            status_code=503,
            detail=f"{platform.capitalize()} is not configured. Set {platform.upper()}_AUTH_CONFIG_ID.",
        )
    return auth_config_id


@api_router.get("/social/{platform}/status")
async def social_status(platform: str, user_id: str = Depends(get_user_id)):
    if platform not in SOCIAL_AUTH_CONFIGS:
        raise HTTPException(status_code=404, detail="Unknown platform")
    auth_config_id = SOCIAL_AUTH_CONFIGS[platform]
    if not auth_config_id:
        return {"platform": platform, "connected": False, "configured": False}

    import asyncio
    def _list():
        client = _composio_client()
        return client.connected_accounts.list(
            user_ids=[user_id],
            auth_config_ids=[auth_config_id],
            statuses=["ACTIVE"],
        )
    try:
        result = await asyncio.to_thread(_list)
        items = getattr(result, "items", None) or list(result or [])
        connected = len(items) > 0
        return {
            "platform": platform,
            "connected": connected,
            "configured": True,
            "connection_id": getattr(items[0], "id", None) if connected else None,
        }
    except Exception as e:
        logger.warning(f"{platform} status check failed: {e}")
        return {"platform": platform, "connected": False, "configured": True, "error": str(e)}


@api_router.post("/social/{platform}/connect")
async def social_connect(platform: str, user_id: str = Depends(get_user_id)):
    if platform not in SOCIAL_AUTH_CONFIGS:
        raise HTTPException(status_code=404, detail="Unknown platform")
    auth_config_id = _require_social_config(platform)

    import asyncio
    def _link(allow_multiple: bool = True):
        client = _composio_client()
        return client.connected_accounts.link(
            user_id=user_id,
            auth_config_id=auth_config_id,
            allow_multiple=allow_multiple,
        )
    try:
        try:
            cr = await asyncio.to_thread(_link, True)
        except Exception as e:
            msg = str(e)
            if "Multiple connected accounts" in msg or "allow_multiple" in msg:
                # User already has at least one connection — surface that
                return {"platform": platform, "redirect_url": None, "already_connected": True}
            raise
        redirect_url = getattr(cr, "redirect_url", None) or getattr(cr, "redirectUrl", None)
        if not redirect_url:
            raise HTTPException(status_code=502, detail="Composio did not return a redirect URL")
        return {"platform": platform, "redirect_url": redirect_url}
    except HTTPException:
        raise
    except Exception as e:
        msg = str(e)
        if "ComposioMultipleConnectedAccountsError" in msg or "already" in msg.lower():
            return {"platform": platform, "redirect_url": None, "already_connected": True}
        logger.error(f"Composio {platform} connect failed: {e}")
        raise HTTPException(status_code=502, detail=f"Composio error: {e}")


def _humanize_provider_error(raw: Any, platform: str) -> str:
    """Convert a raw Composio/HTTP error into a short, user-friendly sentence.
    Module-level so it can be referenced from any branch of social_post / scheduler.
    """
    s = str(raw or "")
    s_low = s.lower()
    if "<html" in s_low or "<!doctype" in s_low or "cloudflare" in s_low or "bad gateway" in s_low:
        return (f"{platform.capitalize()} is temporarily unreachable (gateway returned an HTML error). "
                "Please try again in a minute.")
    if "connectedaccountnotfound" in s_low or "no connected account" in s_low:
        return f"No {platform} account connected. Please connect {platform} in Settings."
    if "invalid request data" in s_low or "invalid_request" in s_low:
        if platform == "instagram":
            return ("Instagram rejected the post. Make sure you're connected to an Instagram Business or "
                    "Creator account and that the image is a JPG/PNG under 8MB.")
        if platform == "facebook":
            return ("Facebook rejected the post. The connected account must be a Facebook Page "
                    "(not a personal profile).")
        return f"{platform.capitalize()} rejected the request. Please check your content and try again."
    if platform == "facebook" and ("page_id" in s_low or ("page" in s_low and "permission" in s_low)):
        return ("Facebook requires posting to a Page (not a personal profile). "
                "Please reconnect Facebook and grant page permissions.")
    if platform == "instagram" and ("ig_user_id" in s_low or "creation_id" in s_low or "business" in s_low):
        return ("Instagram requires a Business or Creator account linked to a Facebook Page. "
                "Reconnect Instagram via Settings.")
    # Trim runaway whitespace and HTML noise
    clean = re.sub(r"\s+", " ", s).strip()
    clean = re.sub(r"<[^>]+>", "", clean)
    return clean[:280] if clean else f"{platform.capitalize()} posting failed."


async def _post_to_instagram(user_id: str, caption: str, image_url: str, connected_account_id: Optional[str], history_id: Optional[str]) -> Dict[str, Any]:
    """Instagram requires a two-phase publish flow:
       1) INSTAGRAM_CREATE_MEDIA_CONTAINER -> returns a creation_id (a.k.a. container id)
       2) INSTAGRAM_CREATE_POST -> publishes the container.
       Both need the user's `ig_user_id` which we discover (and cache) via INSTAGRAM_GET_USER_INFO.
    """
    if not image_url:
        return {"success": False, "platform": "instagram", "error": "Instagram requires an image."}

    ig = await _instagram_get_user_id(user_id, connected_account_id)
    ig_user_id = ig.get("id")
    if not ig_user_id:
        raw = ig.get("error") or ""
        low = str(raw).lower()
        if "connectedaccountnotfound" in low or "no connected account" in low:
            msg = "No Instagram account connected. Please connect Instagram in Settings."
        elif ig.get("error") == "no_business_account":
            msg = "Your Instagram account isn't a Business or Creator account. Convert it (or link it to a Facebook Page) and reconnect Instagram."
        else:
            msg = "Couldn't fetch your Instagram Business account ID. Reconnect Instagram in Settings and make sure it's a Business/Creator account linked to a Facebook Page."
        return {"success": False, "platform": "instagram", "error": msg}

    # Phase 1: container creation
    container = await _composio_call(
        user_id,
        "INSTAGRAM_CREATE_MEDIA_CONTAINER",
        {"ig_user_id": ig_user_id, "image_url": image_url, "caption": caption},
        connected_account_id=connected_account_id,
    )
    if not container["success"]:
        logger.error(f"Composio instagram container failed (provider): {str(container.get('error_raw'))[:500]}")
        return {"success": False, "platform": "instagram", "error": _humanize_provider_error(container.get("error_raw"), "instagram")}

    creation_id = _extract_first(container["data"], ["creation_id", "container_id", "id"])
    if not creation_id:
        logger.error(f"Instagram creation_id not found in container response: {container['data']}")
        return {"success": False, "platform": "instagram", "error": "Instagram didn't return a media id. Please retry."}

    # Phase 2: publish
    publish = await _composio_call(
        user_id,
        "INSTAGRAM_CREATE_POST",
        {"ig_user_id": ig_user_id, "creation_id": str(creation_id)},
        connected_account_id=connected_account_id,
    )
    if not publish["success"]:
        logger.error(f"Composio instagram publish failed (provider): {str(publish.get('error_raw'))[:500]}")
        return {"success": False, "platform": "instagram", "error": _humanize_provider_error(publish.get("error_raw"), "instagram")}

    if history_id:
        await db.history.update_one(
            {"id": history_id, "user_id": user_id},
            {"$addToSet": {"posted_to": {"platform": "instagram", "posted_at": datetime.now(timezone.utc).isoformat()}}},
        )
    return {"success": True, "platform": "instagram", "with_image": True, "result": str(publish["data"])[:400]}


async def _post_to_facebook(user_id: str, message: str, image_url: Optional[str], connected_account_id: Optional[str], history_id: Optional[str]) -> Dict[str, Any]:
    """Post text or photo to a connected Facebook Page.

    Picks the user's first managed page (cached on the user doc). For posts that include
    an image we use FACEBOOK_CREATE_PHOTO_POST; text-only posts go through FACEBOOK_CREATE_POST.
    """
    page = await _facebook_get_page_id(user_id, connected_account_id)
    page_id = page.get("id")
    if not page_id:
        raw = page.get("error") or ""
        low = str(raw).lower()
        if "connectedaccountnotfound" in low or "no connected account" in low:
            msg = "No Facebook account connected. Please connect Facebook in Settings."
        elif page.get("error") == "no_managed_page":
            msg = "We couldn't find any Facebook Page you manage. Posting requires admin access to a Page (not a personal profile)."
        else:
            msg = "Couldn't find a managed Facebook Page on your account. Make sure you're an admin of a Page and reconnect Facebook."
        return {"success": False, "platform": "facebook", "error": msg}

    if image_url:
        slug = "FACEBOOK_CREATE_PHOTO_POST"
        args = {"page_id": page_id, "message": message, "url": image_url}
    else:
        slug = "FACEBOOK_CREATE_POST"
        args = {"page_id": page_id, "message": message}

    res = await _composio_call(user_id, slug, args, connected_account_id=connected_account_id)
    if not res["success"]:
        logger.error(f"Composio facebook post failed (provider): {str(res.get('error_raw'))[:500]}")
        return {"success": False, "platform": "facebook", "error": _humanize_provider_error(res.get("error_raw"), "facebook")}

    if history_id:
        await db.history.update_one(
            {"id": history_id, "user_id": user_id},
            {"$addToSet": {"posted_to": {"platform": "facebook", "posted_at": datetime.now(timezone.utc).isoformat()}}},
        )
    return {"success": True, "platform": "facebook", "with_image": bool(image_url), "result": str(res["data"])[:400]}


@api_router.post("/social/{platform}/post")
async def social_post(platform: str, payload: Dict[str, Any], request: Request, user_id: str = Depends(get_user_id)):
    if platform not in SOCIAL_POST_TOOLS:
        raise HTTPException(status_code=404, detail="Unknown platform")
    _require_social_config(platform)
    content = (payload.get("content") or "").strip()
    image_url = (payload.get("image_url") or "").strip() or None
    image_b64 = payload.get("image_b64") or None  # data URI or raw base64
    image_mime = (payload.get("image_mime") or "image/png").strip()
    history_id = payload.get("history_id")
    if not content:
        raise HTTPException(status_code=400, detail="content is required")

    # If the caller accidentally passed a data: URI as image_url, treat it as base64
    if image_url and image_url.startswith("data:"):
        if not image_b64:
            try:
                head, image_b64 = image_url.split(",", 1)
                if "image/" in head:
                    image_mime = head.split(":")[1].split(";")[0]
            except Exception:
                pass
        image_url = None  # Never pass data URIs downstream — Instagram/Facebook need real HTTPS

    # Strip data-URI prefix on image_b64 if present
    if image_b64 and image_b64.startswith("data:"):
        try:
            head, image_b64 = image_b64.split(",", 1)
            if "image/" in head:
                image_mime = head.split(":")[1].split(";")[0]
        except Exception:
            pass

    tool = SOCIAL_POST_TOOLS[platform]
    if tool["needs_image"] and not image_url and not image_b64:
        raise HTTPException(status_code=400, detail=f"{platform} requires an image")

    # Pick the connected account for the active company if set (multi-account support)
    chosen_conn_id: Optional[str] = None
    try:
        active_company = await _get_active_company(user_id)
        if active_company:
            linked = active_company.get("linked_accounts") or {}
            chosen_conn_id = linked.get(platform)
    except Exception:
        pass

    # LinkedIn-specific: build args with optional image upload
    if platform == "linkedin":
        try:
            author_urn = await _linkedin_get_author_urn(user_id)
        except HTTPException as he:
            # URN fetch may raise its own 502 — convert to clean success:false JSON
            return {"success": False, "platform": platform, "error": str(he.detail)[:280]}
        except Exception as e:
            logger.error(f"LinkedIn URN fetch failed: {e}")
            return {"success": False, "platform": platform, "error": _humanize_provider_error(e, platform)}

        args: Dict[str, Any] = {"author": author_urn, "commentary": content}
        if image_b64:
            try:
                image_attachment = await _linkedin_upload_image(user_id, author_urn, image_b64, image_mime)
                args["images"] = [image_attachment]
            except HTTPException:
                raise
            except Exception as e:
                logger.error(f"LinkedIn image upload failed: {e}")
                # Continue with text-only rather than fail the whole post
                args.pop("images", None)

        slug = tool["slug"]
        import asyncio
        def _execute():
            client = _composio_client()
            kwargs: Dict[str, Any] = {
                "user_id": user_id, "slug": slug, "arguments": args,
                "dangerously_skip_version_check": True,
            }
            if chosen_conn_id:
                kwargs["connected_account_id"] = chosen_conn_id
            return client.tools.execute(**kwargs)

        try:
            result = await asyncio.to_thread(_execute)
            success = True
            err_payload: Any = None
            try:
                if hasattr(result, "successful"):
                    success = bool(result.successful)
                    err_payload = getattr(result, "error", None) or getattr(result, "data", None)
                elif isinstance(result, dict):
                    success = bool(result.get("successful", True))
                    err_payload = result.get("error") or result.get("data")
            except Exception:
                pass
            if not success:
                msg = _humanize_provider_error(err_payload or result, platform)
                logger.error(f"Composio linkedin post failed (provider): {str(err_payload)[:500]}")
                return {"success": False, "platform": platform, "error": msg}
            if history_id:
                await db.history.update_one(
                    {"id": history_id, "user_id": user_id},
                    {"$addToSet": {"posted_to": {"platform": platform, "posted_at": datetime.now(timezone.utc).isoformat()}}},
                )
            return {"success": True, "platform": platform, "with_image": bool(args.get("images") or image_b64), "result": str(result)[:400]}
        except Exception as e:
            logger.error(f"Composio linkedin post failed: {e}")
            return {"success": False, "platform": platform, "error": _humanize_provider_error(e, platform)}

    # Instagram & Facebook need a publicly fetchable HTTPS URL when an image is present.
    if image_b64 and not image_url:
        hosted = await _host_public_image(image_b64, image_mime, request)
        if hosted:
            image_url = hosted
        elif platform == "instagram":
            return {"success": False, "platform": platform, "error": "Couldn't host the image publicly. Please retry — Instagram needs a public image URL."}

    if platform == "instagram":
        return await _post_to_instagram(user_id, content, image_url or "", chosen_conn_id, history_id)
    if platform == "facebook":
        return await _post_to_facebook(user_id, content, image_url, chosen_conn_id, history_id)

    return {"success": False, "platform": platform, "error": f"{platform} posting not supported"}


@api_router.post("/social/{platform}/disconnect")
async def social_disconnect(platform: str, user_id: str = Depends(get_user_id)):
    if platform not in SOCIAL_AUTH_CONFIGS:
        raise HTTPException(status_code=404, detail="Unknown platform")
    auth_config_id = _require_social_config(platform)

    import asyncio
    def _delete_all() -> int:
        client = _composio_client()
        listing = client.connected_accounts.list(
            user_ids=[user_id],
            auth_config_ids=[auth_config_id],
        )
        items = getattr(listing, "items", None) or list(listing or [])
        count = 0
        for item in items:
            conn_id = getattr(item, "id", None) or (item.get("id") if isinstance(item, dict) else None)
            if not conn_id:
                continue
            try:
                client.connected_accounts.delete(nanoid=conn_id)
                count += 1
            except Exception as e:
                logger.warning(f"Failed to delete {platform} connection {conn_id}: {e}")
        return count

    try:
        deleted = await asyncio.to_thread(_delete_all)
        # Clear cached fields on our user record
        unset_fields: Dict[str, str] = {}
        if platform == "linkedin":
            unset_fields = {"linkedin_connection_id": "", "linkedin_connected": "", "linkedin_author_urn": ""}
        elif platform == "instagram":
            unset_fields = {"instagram_user_ids": ""}
        elif platform == "facebook":
            unset_fields = {"facebook_page_ids": ""}
        await db.users.update_one(
            {"user_id": user_id},
            {"$unset": unset_fields, "$set": {"user_id": user_id, "updated_at": datetime.now(timezone.utc).isoformat()}},
            upsert=True,
        )
        return {"platform": platform, "deleted": deleted}
    except Exception as e:
        logger.error(f"Composio {platform} disconnect failed: {e}")
        raise HTTPException(status_code=502, detail=f"Composio error: {e}")


async def _execute_social_post(user_id: str, platform: str, content: str, image_b64: Optional[str], image_mime: Optional[str], history_id: Optional[str]) -> Dict[str, Any]:
    """Internal helper that the scheduler & post endpoint both call."""
    import asyncio
    if platform not in SOCIAL_POST_TOOLS:
        return {"platform": platform, "success": False, "error": "Unknown platform"}
    if not SOCIAL_AUTH_CONFIGS.get(platform):
        return {"platform": platform, "success": False, "error": f"{platform} not configured"}

    # Strip data-URI prefix on image_b64 if present
    if image_b64 and isinstance(image_b64, str) and image_b64.startswith("data:") and "," in image_b64:
        try:
            head, image_b64 = image_b64.split(",", 1)
            if "image/" in head:
                image_mime = head.split(":")[1].split(";")[0]
        except Exception:
            pass

    chosen_conn_id: Optional[str] = None
    active_company = await _get_active_company(user_id)
    if active_company:
        linked = active_company.get("linked_accounts") or {}
        chosen_conn_id = linked.get(platform)

    slug = SOCIAL_POST_TOOLS[platform]["slug"]
    args: Dict[str, Any] = {}

    if platform == "linkedin":
        try:
            author_urn = await _linkedin_get_author_urn(user_id)
        except Exception as e:
            return {"platform": platform, "success": False, "error": f"URN: {e}"}
        args = {"author": author_urn, "commentary": content}
        if image_b64:
            try:
                args["images"] = [await _linkedin_upload_image(user_id, author_urn, image_b64, image_mime or "image/png")]
            except Exception as e:
                logger.warning(f"Schedule image upload failed for linkedin: {e}")
        slug = SOCIAL_POST_TOOLS[platform]["slug"]

        def _exec():
            client = _composio_client()
            kwargs: Dict[str, Any] = {
                "user_id": user_id, "slug": slug, "arguments": args,
                "dangerously_skip_version_check": True,
            }
            if chosen_conn_id:
                kwargs["connected_account_id"] = chosen_conn_id
            return client.tools.execute(**kwargs)

        try:
            result = await asyncio.to_thread(_exec)
            success = True
            err_payload: Any = None
            try:
                if hasattr(result, "successful"):
                    success = bool(result.successful)
                    err_payload = getattr(result, "error", None) or getattr(result, "data", None)
                elif isinstance(result, dict):
                    success = bool(result.get("successful", True))
                    err_payload = result.get("error") or result.get("data")
            except Exception:
                pass
            if not success:
                return {"platform": platform, "success": False, "error": _humanize_provider_error(err_payload or result, platform)}
            if history_id:
                await db.history.update_one(
                    {"id": history_id, "user_id": user_id},
                    {"$addToSet": {"posted_to": {"platform": platform, "posted_at": datetime.now(timezone.utc).isoformat()}}},
                )
            return {"platform": platform, "success": True}
        except Exception as e:
            return {"platform": platform, "success": False, "error": _humanize_provider_error(e, platform)}

    # Instagram & Facebook — delegate to the dedicated helpers which handle the
    # two-phase IG container/publish flow and FB Page selection.
    if platform in ("instagram", "facebook"):
        image_url: Optional[str] = None
        if image_b64:
            image_url = await _host_public_image(image_b64, image_mime or "image/png", None)
        if platform == "instagram":
            if not image_url:
                return {"platform": platform, "success": False, "error": "Instagram requires an image — none was provided or hosting failed."}
            r = await _post_to_instagram(user_id, content, image_url, chosen_conn_id, history_id)
        else:
            r = await _post_to_facebook(user_id, content, image_url, chosen_conn_id, history_id)
        # Normalize shape: scheduler expects {platform, success, error?}
        return {"platform": platform, "success": bool(r.get("success")), "error": r.get("error")}

    return {"platform": platform, "success": False, "error": f"{platform} posting not supported"}


async def _scheduler_loop():
    """Background task that checks for due scheduled posts every 60s."""
    import asyncio
    while True:
        try:
            now = datetime.now(timezone.utc)
            cursor = db.scheduled_posts.find({"status": "scheduled", "scheduled_for": {"$lte": now.isoformat()}})
            async for doc in cursor:
                doc_id = doc["id"]
                await db.scheduled_posts.update_one({"id": doc_id}, {"$set": {"status": "posting"}})
                results = []
                for platform in doc.get("platforms", []):
                    r = await _execute_social_post(
                        doc["user_id"], platform, doc.get("content", ""),
                        doc.get("image_b64"), doc.get("image_mime"), doc.get("history_id"),
                    )
                    results.append(r)
                final_status = "posted" if all(r["success"] for r in results) else "failed"
                await db.scheduled_posts.update_one(
                    {"id": doc_id},
                    {"$set": {"status": final_status, "results": results, "posted_at": datetime.now(timezone.utc).isoformat()}, "$unset": {"image_b64": ""}},
                )
        except Exception as e:
            logger.error(f"Scheduler loop error: {e}")
        await asyncio.sleep(60)


@api_router.get("/social/{platform}/accounts")
async def list_social_accounts(platform: str, user_id: str = Depends(get_user_id)):
    if platform not in SOCIAL_AUTH_CONFIGS:
        raise HTTPException(status_code=404, detail="Unknown platform")
    auth_config_id = SOCIAL_AUTH_CONFIGS.get(platform, "")
    if not auth_config_id:
        return {"platform": platform, "accounts": [], "configured": False}
    import asyncio
    def _list():
        client = _composio_client()
        return client.connected_accounts.list(
            user_ids=[user_id],
            auth_config_ids=[auth_config_id],
        )
    result = await asyncio.to_thread(_list)
    items = getattr(result, "items", None) or list(result or [])
    accounts = []
    for it in items:
        conn_id = getattr(it, "id", None) or (it.get("id") if isinstance(it, dict) else None)
        status = getattr(it, "status", None) or (it.get("status") if isinstance(it, dict) else None)
        created = getattr(it, "created_at", None) or (it.get("created_at") if isinstance(it, dict) else None)
        if not conn_id:
            continue
        # Best-effort display name fetch
        display_name = None
        if platform == "linkedin" and status == "ACTIVE":
            try:
                def _info():
                    client = _composio_client()
                    return client.tools.execute(
                        user_id=user_id,
                        slug="LINKEDIN_GET_MY_INFO",
                        arguments={},
                        connected_account_id=conn_id,
                        dangerously_skip_version_check=True,
                    )
                info = await asyncio.to_thread(_info) if False else await asyncio.to_thread(_info)
                data = getattr(info, "data", None) or (info.get("data") if isinstance(info, dict) else None) or {}
                if isinstance(data, dict):
                    display_name = data.get("name") or data.get("given_name") or data.get("localizedFirstName")
            except Exception as e:
                logger.warning(f"Could not fetch display name for {conn_id}: {e}")
        accounts.append({
            "id": conn_id,
            "status": status,
            "created_at": created,
            "display_name": display_name or f"…{conn_id[-8:]}",
        })
    return {"platform": platform, "accounts": accounts, "configured": True}


@api_router.delete("/social/{platform}/accounts/{conn_id}")
async def delete_social_account(platform: str, conn_id: str, user_id: str = Depends(get_user_id)):
    import asyncio
    def _del():
        client = _composio_client()
        return client.connected_accounts.delete(nanoid=conn_id)
    try:
        await asyncio.to_thread(_del)
    except Exception as e:
        logger.warning(f"Delete connection {conn_id} failed: {e}")
        raise HTTPException(status_code=502, detail=str(e)[:200])
    # Remove from any company that referenced this account
    await db.companies.update_many(
        {"user_id": user_id, f"linked_accounts.{platform}": conn_id},
        {"$unset": {f"linked_accounts.{platform}": ""}},
    )
    return {"deleted": True}


@api_router.post("/companies/{company_id}/link-account")
async def link_account_to_company(company_id: str, payload: Dict[str, Any], user_id: str = Depends(get_user_id)):
    platform = (payload.get("platform") or "").strip().lower()
    account_id = (payload.get("connected_account_id") or "").strip() or None  # null clears
    if platform not in SOCIAL_AUTH_CONFIGS:
        raise HTTPException(status_code=400, detail="Unknown platform")
    update = {f"linked_accounts.{platform}": account_id} if account_id else {}
    unset = {f"linked_accounts.{platform}": ""} if not account_id else {}
    res = await db.companies.update_one(
        {"id": company_id, "user_id": user_id},
        {"$set": update, "$unset": unset},
    )
    if res.matched_count == 0:
        raise HTTPException(status_code=404, detail="Company not found")
    return await db.companies.find_one({"id": company_id, "user_id": user_id}, {"_id": 0})


# --- Legacy LinkedIn-specific endpoints (kept for the post button on result cards) ---
@api_router.get("/composio/linkedin/status")
async def linkedin_status_legacy(user_id: str = Depends(get_user_id)):
    return await social_status("linkedin", user_id)


@api_router.post("/composio/linkedin/connect")
async def linkedin_connect_legacy(user_id: str = Depends(get_user_id)):
    return await social_connect("linkedin", user_id)


@api_router.post("/composio/linkedin/post")
async def linkedin_post(payload: Dict[str, Any], user_id: str = Depends(get_user_id)):
    _require_social_config("linkedin")
    content = (payload.get("content") or "").strip()
    if not content:
        raise HTTPException(status_code=400, detail="content is required")
    import asyncio
    def _execute():
        client = _composio_client()
        # Fetch URN inline so the legacy endpoint stays self-contained
        info = client.tools.execute(
            user_id=user_id,
            slug="LINKEDIN_GET_MY_INFO",
            arguments={},
            dangerously_skip_version_check=True,
        )
        info_data: Any = getattr(info, "data", None) or (info.get("data") if isinstance(info, dict) else None) or info
        person_id = None
        if isinstance(info_data, dict):
            person_id = info_data.get("id") or info_data.get("sub")
        if not person_id:
            raise RuntimeError("Could not resolve LinkedIn person URN")
        return client.tools.execute(
            user_id=user_id,
            slug="LINKEDIN_CREATE_LINKED_IN_POST",
            arguments={"author": f"urn:li:person:{person_id}", "commentary": content},
            dangerously_skip_version_check=True,
        )
    try:
        result = await asyncio.to_thread(_execute)
        await db.users.update_one(
            {"user_id": user_id},
            {"$set": {"linkedin_connected": True}},
            upsert=True,
        )
        return {"success": True, "result": str(result)[:1000]}
    except Exception as e:
        logger.error(f"Composio LinkedIn post failed: {e}")
        raise HTTPException(status_code=502, detail=f"Composio error: {e}")


# ---------- Mount ----------
app.include_router(api_router)

app.add_middleware(
    CORSMiddleware,
    allow_credentials=True,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
async def _start_scheduler():
    import asyncio
    asyncio.create_task(_scheduler_loop())


@app.on_event("shutdown")
async def shutdown_db_client():
    client.close()
