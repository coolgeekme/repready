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

from emergentintegrations.llm.chat import LlmChat, UserMessage

ROOT_DIR = Path(__file__).parent
load_dotenv(ROOT_DIR / ".env")

# ---------- Setup ----------
mongo_url = os.environ["MONGO_URL"]
client = AsyncIOMotorClient(mongo_url)
db = client[os.environ["DB_NAME"]]

EMERGENT_LLM_KEY = os.environ["EMERGENT_LLM_KEY"]
COMPOSIO_API_KEY = os.environ["COMPOSIO_API_KEY"]
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
    """Extract a JSON object/array from an LLM response."""
    text = text.strip()
    # Strip code fences
    text = re.sub(r"^```(?:json)?\s*", "", text)
    text = re.sub(r"\s*```$", "", text)
    try:
        return json.loads(text)
    except Exception:
        # Find the first { or [
        match = re.search(r"(\{.*\}|\[.*\])", text, re.S)
        if match:
            return json.loads(match.group(1))
        raise


async def _llm_generate_json(system_msg: str, user_msg: str) -> Any:
    chat = LlmChat(
        api_key=EMERGENT_LLM_KEY,
        session_id=f"repready-{uuid.uuid4()}",
        system_message=system_msg,
    ).with_model("anthropic", CLAUDE_MODEL).with_params(max_tokens=2000)

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
    if profile.get("target_audience"):
        parts.append(f"Target Audience: {profile['target_audience']}")
    if profile.get("guidelines_text"):
        parts.append(f"Company Guidelines:\n{profile['guidelines_text'][:2000]}")
    return "\n".join(parts) if parts else "No profile context provided."


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
        "Always reply with strict, valid JSON only — no prose, no markdown fences."
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


# ---------- Routes: Composio LinkedIn ----------
def _composio_toolset():
    from composio import ComposioToolSet
    return ComposioToolSet(api_key=COMPOSIO_API_KEY)


@api_router.get("/composio/linkedin/status")
async def linkedin_status(user_id: str = Depends(get_user_id)):
    profile = await _get_profile(user_id)
    return {
        "connected": bool(profile.get("linkedin_connected")),
        "connection_id": profile.get("linkedin_connection_id"),
    }


@api_router.post("/composio/linkedin/connect")
async def linkedin_connect(user_id: str = Depends(get_user_id)):
    try:
        toolset = _composio_toolset()
        entity = toolset.get_entity(entity_id=user_id)
        connection = entity.initiate_connection(app_name="linkedin")
        await db.users.update_one(
            {"user_id": user_id},
            {"$set": {
                "user_id": user_id,
                "linkedin_connection_id": getattr(connection, "connectedAccountId", None),
                "updated_at": datetime.now(timezone.utc).isoformat(),
            }},
            upsert=True,
        )
        return {"redirect_url": getattr(connection, "redirectUrl", None)}
    except Exception as e:
        logger.error(f"Composio LinkedIn connect failed: {e}")
        raise HTTPException(status_code=502, detail=f"Composio error: {e}")


@api_router.post("/composio/linkedin/post")
async def linkedin_post(payload: Dict[str, Any], user_id: str = Depends(get_user_id)):
    content = payload.get("content", "").strip()
    if not content:
        raise HTTPException(status_code=400, detail="content is required")
    try:
        toolset = _composio_toolset()
        entity = toolset.get_entity(entity_id=user_id)
        result = entity.execute(action="LINKEDIN_CREATE_POST", params={"commentary": content})
        # Mark connected once a successful post happens
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
