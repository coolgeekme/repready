from fastapi import FastAPI, APIRouter, HTTPException, Header, Depends
from dotenv import load_dotenv
from starlette.middleware.cors import CORSMiddleware
from motor.motor_asyncio import AsyncIOMotorClient
import os
import logging
import json
import uuid
import re
from pathlib import Path
from pydantic import BaseModel, Field
from typing import List, Optional, Dict, Any
from datetime import datetime, timezone

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
async def get_user_id(x_user_id: Optional[str] = Header(None)) -> str:
    """For MVP we trust the Firebase UID passed from the authenticated client.
    Firebase JS SDK is the source of truth for auth on the client.
    """
    if not x_user_id:
        raise HTTPException(status_code=401, detail="Missing X-User-Id header")
    return x_user_id


# ---------- Models ----------
class UserProfile(BaseModel):
    user_id: str
    email: Optional[str] = None
    display_name: Optional[str] = None
    role: Optional[str] = None
    industry: Optional[str] = None
    target_audience: Optional[str] = None
    # Company info (used as context in every generation)
    company_name: Optional[str] = None
    company_website: Optional[str] = None
    company_offerings: Optional[str] = None
    company_value_props: Optional[str] = None
    guidelines_text: Optional[str] = None
    guidelines_file_name: Optional[str] = None
    guidelines_file_b64: Optional[str] = None  # base64 PDF
    linkedin_connected: bool = False
    linkedin_connection_id: Optional[str] = None
    updated_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))


class ProfileUpdate(BaseModel):
    email: Optional[str] = None
    display_name: Optional[str] = None
    role: Optional[str] = None
    industry: Optional[str] = None
    target_audience: Optional[str] = None
    company_name: Optional[str] = None
    company_website: Optional[str] = None
    company_offerings: Optional[str] = None
    company_value_props: Optional[str] = None
    guidelines_text: Optional[str] = None
    guidelines_file_name: Optional[str] = None
    guidelines_file_b64: Optional[str] = None


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


def _profile_context(profile: Dict[str, Any]) -> str:
    parts = []
    if profile.get("role"):
        parts.append(f"Sales Role: {profile['role']}")
    if profile.get("industry"):
        parts.append(f"Industry: {profile['industry']}")
    if profile.get("company_name"):
        parts.append(f"Company: {profile['company_name']}")
    if profile.get("company_website"):
        parts.append(f"Website: {profile['company_website']}")
    if profile.get("company_offerings"):
        parts.append(f"What the company sells / offerings:\n{profile['company_offerings'][:1500]}")
    if profile.get("company_value_props"):
        parts.append(f"Key value props / differentiators:\n{profile['company_value_props'][:1000]}")
    if profile.get("target_audience"):
        parts.append(f"Target Audience: {profile['target_audience']}")
    if profile.get("guidelines_text"):
        parts.append(f"Brand voice & guidelines:\n{profile['guidelines_text'][:1500]}")
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
    return profile


@api_router.put("/users/profile")
async def update_profile(payload: ProfileUpdate, user_id: str = Depends(get_user_id)):
    update = {k: v for k, v in payload.dict().items() if v is not None}
    update["updated_at"] = datetime.now(timezone.utc).isoformat()
    update["user_id"] = user_id
    await db.users.update_one({"user_id": user_id}, {"$set": update}, upsert=True)
    profile = await _get_profile(user_id)
    return profile


# ---------- Routes: Generators ----------
async def _generate(user_id: str, type_: str, schema_hint: str, prompt: str, req: GenerateRequest, title: str) -> Dict:
    profile = await _get_profile(user_id)
    context = _profile_context(profile)
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
    return {"id": item["id"], "type": type_, "title": title, "output": output, "created_at": item["created_at"]}


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
    industry = profile.get("industry") or "business"
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
        "build_args": lambda content, image_url=None: {"text": content},
        "needs_image": False,
    },
    "facebook": {
        "slug": "FACEBOOK_CREATE_POST",
        "build_args": lambda content, image_url=None: {"text": content},
        "needs_image": False,
    },
    "instagram": {
        "slug": "INSTAGRAM_CREATE_POST",
        "build_args": lambda content, image_url=None: {"caption": content, "image_url": image_url or ""},
        "needs_image": True,
    },
}


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
    def _link():
        client = _composio_client()
        return client.connected_accounts.link(
            user_id=user_id,
            auth_config_id=auth_config_id,
        )
    try:
        cr = await asyncio.to_thread(_link)
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


@api_router.post("/social/{platform}/post")
async def social_post(platform: str, payload: Dict[str, Any], user_id: str = Depends(get_user_id)):
    if platform not in SOCIAL_POST_TOOLS:
        raise HTTPException(status_code=404, detail="Unknown platform")
    _require_social_config(platform)
    content = (payload.get("content") or "").strip()
    image_url = (payload.get("image_url") or "").strip() or None
    if not content:
        raise HTTPException(status_code=400, detail="content is required")

    tool = SOCIAL_POST_TOOLS[platform]
    if tool["needs_image"] and not image_url:
        raise HTTPException(status_code=400, detail=f"{platform} requires an image_url")

    args = tool["build_args"](content, image_url)
    slug = tool["slug"]
    import asyncio
    def _execute():
        client = _composio_client()
        return client.tools.execute(
            user_id=user_id,
            slug=slug,
            arguments=args,
            dangerously_skip_version_check=True,
        )
    try:
        result = await asyncio.to_thread(_execute)
        # Try to surface a useful success/error from the wrapped response
        success = True
        data: Any = result
        try:
            if hasattr(result, "successful"):
                success = bool(result.successful)
            elif isinstance(result, dict):
                success = bool(result.get("successful", True))
                data = result
        except Exception:
            pass
        if not success:
            err_msg = getattr(result, "error", None) or (isinstance(result, dict) and result.get("error")) or "Action failed"
            raise HTTPException(status_code=502, detail=f"Composio {platform} action failed: {err_msg}")
        return {"success": True, "platform": platform, "result": str(data)[:1000]}
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Composio {platform} post failed: {e}")
        raise HTTPException(status_code=502, detail=f"Composio error: {e}")


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
        return client.tools.execute(
            user_id=user_id,
            slug="LINKEDIN_CREATE_LINKED_IN_POST",
            arguments={"text": content},
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


@app.on_event("shutdown")
async def shutdown_db_client():
    client.close()
