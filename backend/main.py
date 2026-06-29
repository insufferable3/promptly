import asyncio
import hmac
import json
import logging
import os
import re
import secrets
import time
from urllib.parse import urlencode, urlparse
from difflib import SequenceMatcher
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

import httpx
from dotenv import load_dotenv
from fastapi import Depends, FastAPI, Header, HTTPException, Request, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from google.auth.transport.requests import Request as GoogleAuthRequest
from google.oauth2 import id_token as google_id_token
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import Flow
from googleapiclient.discovery import build
from sqlalchemy import inspect, text
from sqlalchemy.orm import Session

BACKEND_DIR = Path(__file__).resolve().parent
load_dotenv(BACKEND_DIR / ".env", override=True)

from database import Base, engine, get_db
from firebase_sync import (
    delete_calendar_event as firebase_delete_calendar_event,
    delete_reminder as firebase_delete_reminder,
    delete_task as firebase_delete_task,
    firebase_status,
    schedule_firebase_sync,
    sync_calendar_event as firebase_sync_calendar_event,
    sync_reminder as firebase_sync_reminder,
    sync_task as firebase_sync_task,
    sync_user as firebase_sync_user,
)
from models import AuthSession, CalendarEvent, OAuthState, Reminder, Task, User
from productivity import build_daily_briefing, task_priority_score
from schemas import (
    AIRequest,
    AIResponse,
    AgentAction,
    AgentPlannerDecision,
    AgentRequest,
    AgentResponse,
    AgentScheduleBlock,
    AgentTaskSuggestion,
    AuthResponse,
    CalendarEventCreate,
    CalendarEventOut,
    GoogleCalendarEventCreate,
    GoogleCalendarEventOut,
    LoginRequest,
    N8nWebhookRequest,
    ReminderCreate,
    ReminderOut,
    TaskCreate,
    TaskOut,
    TaskUpdate,
    UserCreate,
)

STATIC_DIR = Path(os.getenv("STATIC_DIR", str(BACKEND_DIR.parent / "dist")))
if not STATIC_DIR.is_absolute():
    STATIC_DIR = BACKEND_DIR / STATIC_DIR

Base.metadata.create_all(bind=engine)


def ensure_runtime_schema() -> None:
    inspector = inspect(engine)
    table_names = inspector.get_table_names()
    if "oauth_states" in table_names:
        oauth_columns = {column["name"] for column in inspector.get_columns("oauth_states")}
        oauth_indexes = {index["name"] for index in inspector.get_indexes("oauth_states")}
        with engine.begin() as connection:
            if "user_id" not in oauth_columns:
                connection.execute(text("ALTER TABLE oauth_states ADD COLUMN user_id INTEGER REFERENCES users(id)"))
            if "ix_oauth_states_user_id" not in oauth_indexes:
                connection.execute(text("CREATE INDEX IF NOT EXISTS ix_oauth_states_user_id ON oauth_states (user_id)"))

    if "calendar_events" not in table_names:
        return
    columns = {column["name"] for column in inspector.get_columns("calendar_events")}
    indexes = {index["name"] for index in inspector.get_indexes("calendar_events")}
    foreign_keys = inspector.get_foreign_keys("calendar_events")
    has_task_fk = any(
        "task_id" in foreign_key.get("constrained_columns", [])
        and foreign_key.get("referred_table") == "tasks"
        for foreign_key in foreign_keys
    )

    with engine.begin() as connection:
        if "task_id" not in columns:
            connection.execute(
                text("ALTER TABLE calendar_events ADD COLUMN task_id INTEGER REFERENCES tasks(id)")
            )
            has_task_fk = True

        if "ix_calendar_events_task_id" not in indexes:
            connection.execute(
                text("CREATE INDEX IF NOT EXISTS ix_calendar_events_task_id ON calendar_events (task_id)")
            )

        if engine.dialect.name == "postgresql" and not has_task_fk:
            connection.execute(
                text(
                    "ALTER TABLE calendar_events "
                    "ADD CONSTRAINT fk_calendar_events_task_id_tasks "
                    "FOREIGN KEY (task_id) REFERENCES tasks(id)"
                )
            )


ensure_runtime_schema()

PUBLIC_BASE_URL = os.getenv("PUBLIC_BASE_URL", "").strip().rstrip("/")

app = FastAPI(title="Promptly API", version="0.2.0")

allowed_origins = [
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    "http://localhost:3000",
    "http://127.0.0.1:3000",
]
if PUBLIC_BASE_URL:
    allowed_origins.append(PUBLIC_BASE_URL)

app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins,
    allow_origin_regex=r"http://(localhost|127\.0\.0\.1):\d+",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

logger = logging.getLogger("promptly")
OLLAMA_BASE_URL = os.getenv("OLLAMA_BASE_URL", "http://127.0.0.1:11434")
OLLAMA_MODEL = os.getenv("OLLAMA_MODEL", "mistral")
MISTRAL_API_KEY = os.getenv("MISTRAL_API_KEY", "").strip()
MISTRAL_API_MODEL = os.getenv("MISTRAL_API_MODEL", "mistral-small-latest").strip()
MISTRAL_API_URL = os.getenv("MISTRAL_API_URL", "https://api.mistral.ai/v1/chat/completions").strip()
MISTRAL_MODELS_URL = os.getenv("MISTRAL_MODELS_URL", "https://api.mistral.ai/v1/models").strip()
GOOGLE_CALENDAR_SCOPES = ["https://www.googleapis.com/auth/calendar"]
GOOGLE_LOGIN_SCOPES = [
    "openid",
    "https://www.googleapis.com/auth/userinfo.email",
    "https://www.googleapis.com/auth/userinfo.profile",
]
def backend_path_from_env(name: str, default: str) -> Path:
    configured = Path(os.getenv(name, default))
    return configured if configured.is_absolute() else BACKEND_DIR / configured


GOOGLE_CREDENTIALS_PATH = backend_path_from_env("GOOGLE_CREDENTIALS_PATH", "google_credentials.json")
GOOGLE_CREDENTIALS_JSON = os.getenv("GOOGLE_CREDENTIALS_JSON", "").strip()
GOOGLE_TOKEN_PATH = backend_path_from_env("GOOGLE_TOKEN_PATH", "google_token.json")
GOOGLE_REDIRECT_URI = os.getenv(
    "GOOGLE_REDIRECT_URI",
    "http://localhost:8000/auth/google/callback",
)
if PUBLIC_BASE_URL and "GOOGLE_REDIRECT_URI" not in os.environ:
    GOOGLE_REDIRECT_URI = f"{PUBLIC_BASE_URL}/auth/google/callback"
FRONTEND_REDIRECT_URL = os.getenv(
    "FRONTEND_REDIRECT_URL",
    f"{PUBLIC_BASE_URL}/" if PUBLIC_BASE_URL else "http://127.0.0.1:5173/",
).strip()
OAUTH_FRONTEND_REDIRECTS: dict[str, str] = {}
N8N_WEBHOOK_SECRET = os.getenv("N8N_WEBHOOK_SECRET", "").strip()
if GOOGLE_REDIRECT_URI.startswith("http://localhost") or GOOGLE_REDIRECT_URI.startswith("http://127.0.0.1"):
    os.environ.setdefault("OAUTHLIB_INSECURE_TRANSPORT", "1")
os.environ.setdefault("OAUTHLIB_RELAX_TOKEN_SCOPE", "1")
APP_TIMEZONE = ZoneInfo(os.getenv("APP_TIMEZONE", "Asia/Kolkata"))
last_mistral_error: str | None = None
last_mistral_verification: dict | None = None
last_mistral_verification_at = 0.0
desktop_widget_state = {
    "hidden": False,
    "show_request_id": 0,
    "updated_at": None,
}
TEMPORAL_WORDS = {
    "tomorrow": {"tmrw", "tom", "tomo", "tomm", "tommorow", "tomorow", "tomarrow", "tommorrow"},
    "today": {"tdy", "todai", "toady"},
    "tonight": {"tonite", "tngt"},
    "morning": {"mornin", "moring", "mrng"},
    "afternoon": {"afternon", "aftnoon"},
    "evening": {"evenin", "evning", "eveing"},
    "night": {"nite"},
}
PRONOUN_TITLES = {"that", "it", "this", "those", "them"}
JUNK_TITLES = {
    "hi", "hey", "hello", "ok", "okay", "thanks", "thank you", "yes", "no",
    "yep", "nope", "sure", "cool", "nice", "that", "it", "this", "those",
    "them", "yo", "sup", "lol", "haha",
}
TASK_ACTION_PATTERN = (
    r"call|email|message|text|pay|buy|take|send|submit|"
    r"pick\s+up|meet|visit|finish|complete|read|write|practice|revise|"
    r"clean|wash|cook|make|prepare|fix|repair|organize|tidy|study|workout|gym"
)
MONTH_NAMES = {
    "jan": "January",
    "january": "January",
    "feb": "February",
    "february": "February",
    "mar": "March",
    "march": "March",
    "apr": "April",
    "april": "April",
    "may": "May",
    "jun": "June",
    "june": "June",
    "jul": "July",
    "july": "July",
    "aug": "August",
    "august": "August",
    "sep": "September",
    "sept": "September",
    "september": "September",
    "oct": "October",
    "october": "October",
    "nov": "November",
    "november": "November",
    "dec": "December",
    "december": "December",
}
MONTH_PATTERN = "|".join(MONTH_NAMES)


def mistral_key_fingerprint() -> str:
    key = MISTRAL_API_KEY
    return f"{key[:4]}...{key[-4:]}" if len(key) >= 8 else "missing"


def verify_mistral_api_key(force: bool = False) -> dict:
    global last_mistral_error, last_mistral_verification, last_mistral_verification_at
    now = time.monotonic()
    if (
        not force
        and last_mistral_verification
        and now - last_mistral_verification_at < 30
    ):
        if last_mistral_verification.get("status") == "ok":
            last_mistral_error = None
        return last_mistral_verification

    result = {
        "status": "error",
        "model": MISTRAL_API_MODEL,
        "key_fingerprint": mistral_key_fingerprint(),
        "models_reachable": False,
    }
    if not MISTRAL_API_KEY:
        result["status"] = "unauthorized"
        result["detail"] = "Mistral API key is missing."
    else:
        try:
            response = httpx.get(
                MISTRAL_MODELS_URL,
                headers={"Authorization": f"Bearer {MISTRAL_API_KEY}"},
                timeout=float(os.getenv("MISTRAL_VERIFY_TIMEOUT_SECONDS", "6")),
            )
            if response.status_code == 200:
                result["status"] = "ok"
                result["models_reachable"] = True
                last_mistral_error = None
            elif response.status_code == 401:
                result["status"] = "unauthorized"
                result["detail"] = "Mistral API key is invalid or missing."
                last_mistral_error = result["detail"]
            elif response.status_code == 402:
                result["status"] = "payment_required"
                result["detail"] = "Mistral billing or payment is required."
                last_mistral_error = result["detail"]
            elif response.status_code == 429:
                result["status"] = "rate_limited"
                result["detail"] = "Mistral rate limit or credits were exceeded."
                last_mistral_error = result["detail"]
            else:
                result["detail"] = f"Mistral models endpoint returned HTTP {response.status_code}."
                last_mistral_error = result["detail"]
        except Exception as exc:
            result["detail"] = f"Mistral verification failed: {type(exc).__name__}."
            last_mistral_error = result["detail"]
            logger.warning("Mistral verification failed: %s: %s", type(exc).__name__, exc)

    last_mistral_verification = result
    last_mistral_verification_at = now
    return result


def normalize_temporal_typos(message: str) -> str:
    def normalize_token(match: re.Match) -> str:
        token = match.group(0)
        lower = token.lower()
        for canonical, aliases in TEMPORAL_WORDS.items():
            if lower == canonical or lower in aliases:
                return canonical
            if (
                len(lower) >= 5
                and lower[0] == canonical[0]
                and SequenceMatcher(None, lower, canonical).ratio() >= 0.72
            ):
                return canonical
        return token

    return re.sub(r"[A-Za-z]+", normalize_token, message)


def polish_task_title(title: str) -> str:
    cleaned = re.sub(r"\s+", " ", title).strip(" .")
    acronym_words = {"ai", "dbms", "dsa", "sql", "api", "ui", "ux", "leetcode"}
    return " ".join(
        "LeetCode" if word.lower() == "leetcode"
        else word.upper() if word.lower() in acronym_words
        else word
        for word in cleaned.split()
    )[:80]


def extract_date_label(message: str) -> str | None:
    lower = normalize_temporal_typos(message).lower()
    month_first = re.search(
        rf"\b({MONTH_PATTERN})\s+(\d{{1,2}})(?:st|nd|rd|th)?\b",
        lower,
        re.I,
    )
    day_first = re.search(
        rf"\b(\d{{1,2}})(?:st|nd|rd|th)?(?:\s+of)?\s+({MONTH_PATTERN})\b",
        lower,
        re.I,
    )
    if month_first or day_first:
        month_name = (month_first.group(1) if month_first else day_first.group(2)).lower()
        day = int(month_first.group(2) if month_first else day_first.group(1))
        return f"{MONTH_NAMES[month_name]} {day}"
    return None


def build_agent_steps(message: str, category: str, response: dict) -> list[str]:
    task_count = len(response.get("suggested_tasks", []))
    block_count = len(response.get("schedule_blocks", []))
    steps = [
        f"Parsed request as a {category} task.",
        f"Estimated effort from context and generated {task_count or 1} task option(s).",
        "Prioritized by deadline, workload pressure, and category.",
    ]
    if block_count:
        steps.extend([
            f"Confirmed explicit calendar intent and prepared {block_count} focus slot suggestion(s).",
            "Applied the task and requested focus session.",
        ])
    else:
        steps.append("Kept the task out of Focus Sessions because no calendar block was requested.")
    return steps


def extract_task_title(message: str) -> str:
    title = normalize_temporal_typos(message).lower()
    title = re.sub(r"\b(please|pls|can you|could you|kindly)\b", " ", title, flags=re.I)
    title = re.sub(r"^\s*(?:add|create|make|set)\s+(?:a\s+|an\s+)?reminders?\s+(?:to\s+)?", "", title, flags=re.I)
    title = re.sub(r"^\s*remind\s+me\s+to\s+", "", title, flags=re.I)
    title = re.sub(r"^\s*remember\s+to\s+", "", title, flags=re.I)
    title = re.sub(r"^\s*i\s+(?:wanna|want to|would like to|need to|have to|gotta)\s+", "", title, flags=re.I)
    title = re.sub(r"\b(add|create|schedule|make|put|block|set|plan)\b", " ", title, flags=re.I)
    title = re.sub(r"\b(to|in|on|into)\s+(my\s+)?(calendar|calender|calander|cal|task|tasks|reminder|reminders)\b", " ", title, flags=re.I)
    title = re.sub(r"\b(calendar|calender|calander|cal|task|tasks|reminder|reminders)\b", " ", title, flags=re.I)
    title = re.sub(rf"\b(?:on\s+)?\d{{1,2}}(?:st|nd|rd|th)?(?:\s+of)?\s+(?:{MONTH_PATTERN})\b.*$", " ", title, flags=re.I)
    title = re.sub(rf"\b(?:on\s+)?(?:{MONTH_PATTERN})\s+\d{{1,2}}(?:st|nd|rd|th)?\b.*$", " ", title, flags=re.I)
    title = re.sub(r"\b(from|for|at|by|due|tomorrow|tomm+o*r+o*w+|today|tonight|morning|evening|afternoon|night)\b.*$", " ", title, flags=re.I)
    title = re.sub(
        r"\b\d{1,2}(?::\d{2})?\s*(?:am|pm)?\s*(?:-|–|\bto\b)\s*\d{1,2}(?::\d{2})?\s*(?:am|pm)?\b",
        " ",
        title,
        flags=re.I,
    )
    title = re.sub(r"\b\d{1,2}(?::\d{2})?\s*(?:am|pm)\b", " ", title, flags=re.I)
    title = re.sub(r"^\s*i\s+have\s+(a|an)?\s*", "", title, flags=re.I).strip()
    title = re.sub(r"\s+", " ", title).strip(" .")

    if not title:
        title = re.sub(r"\b(add|create|schedule|make|put|calendar|calender|calander|task|reminder)\b", " ", message, flags=re.I)
        title = re.sub(r"\s+", " ", title).strip(" .")

    if title.startswith("study "):
        title = f"{title.removeprefix('study ').strip()} practice"
    cleaned = polish_task_title(title)
    if not cleaned or cleaned.lower() in PRONOUN_TITLES or cleaned.lower() in JUNK_TITLES:
        return "Untitled task"
    return cleaned


def extract_duration_minutes(message: str, default: int = 45) -> int:
    lower = message.lower()
    hour_match = re.search(
        r"\bfor\s+(?:(\d+(?:\.\d+)?)|an?|one|two|three)\s*(?:hours?|hrs?)\b",
        lower,
    )
    if hour_match:
        raw_value = hour_match.group(1)
        word_match = re.search(r"\b(an?|one|two|three)\s*(?:hours?|hrs?)\b", hour_match.group(0))
        word_values = {"a": 1, "an": 1, "one": 1, "two": 2, "three": 3}
        hours = float(raw_value) if raw_value else word_values.get(word_match.group(1), 1)
        return max(15, min(480, round(hours * 60)))
    minute_match = re.search(r"\bfor\s+(\d+)\s*(?:minutes?|mins?)\b", lower)
    if minute_match:
        return max(15, min(480, int(minute_match.group(1))))
    return default


def resolve_contextual_message(message: str, history: list[dict[str, str]] | None) -> str:
    if not re.search(r"\b(that|it|this)\b", message, re.I):
        return message
    for item in reversed(history or []):
        if item.get("role") != "user":
            continue
        previous = str(item.get("content") or "").strip()
        if not previous or re.search(r"\b(that|it|this)\b", previous, re.I):
            continue
        if not is_actionable_productivity_request(previous):
            continue
        previous_title = extract_task_title(previous)
        if previous_title and previous_title != "Untitled task":
            return re.sub(r"\b(that|it|this)\b", previous_title, message, count=1, flags=re.I)
    return message


def is_time_correction_message(message: str) -> bool:
    lower = message.strip().lower()
    has_correction_language = bool(re.search(r"\b(not|instead|actually|change|move|shift|update|wrong)\b", lower))
    has_time_language = bool(re.search(r"\b(am|pm|morning|evening|afternoon|night|\d{1,2}(?::\d{2})?)\b", lower))
    has_new_task_language = bool(re.search(r"\b(add|create|schedule|assignment|exam|project|meeting|task|study|work)\b", lower))
    return has_correction_language and has_time_language and not has_new_task_language


def smart_time_correction_response(message: str, category: str) -> dict:
    meridiem = "PM" if re.search(r"\bpm\b", message, re.I) else "AM" if re.search(r"\bam\b", message, re.I) else "the new time"
    response = {
        "title": "Time correction detected",
        "badge": "Promptly",
        "reasoning": "This sounds like an edit to an existing scheduled task, not a new task.",
        "content": f"I understood that as a correction. I will update the latest scheduled task to {meridiem} instead of creating a new task.",
        "followUp": "Tip: you can also drag a task onto the calendar slot you want.",
        "actions": [{"label": "Correction detected", "tool": "time_correction"}],
        "suggested_tasks": [],
        "schedule_blocks": [],
        "suggested_reminders": [],
        "agent_steps": [
            "Detected correction wording.",
            "Avoided creating a duplicate task.",
            "Left the final update to the active task context in the app.",
        ],
        "model_source": "fallback",
    }
    return response


def is_actionable_productivity_request(message: str) -> bool:
    return classify_request_intent(message) in {"create_task", "update_task", "delete_task"}


def has_explicit_task_creation_intent(message: str) -> bool:
    lower = normalize_temporal_typos(message).strip().lower()
    return bool(
        re.search(r"\b(add|create|schedule|remind|remember|plan|block|put|set)\b", lower)
        or re.match(r"^i\s+(?:need|have|must|will|want|wanna|gotta)\s+to\b", lower)
    )


def has_explicit_reminder_creation_intent(message: str) -> bool:
    lower = normalize_temporal_typos(message).strip().lower()
    return bool(re.match(
        r"^(?:please\s+|pls\s+)?(?:(?:add|create|make|set)\s+(?:a\s+|an\s+)?reminders?\b|remind\s+me\b|remember\s+to\b)",
        lower,
    ))


def classify_request_intent(message: str) -> str:
    lower = normalize_temporal_typos(message).strip().lower()
    if not lower:
        return "chat"
    if re.fullmatch(r"(hi+|hey+|hello+|yo+|sup|thanks?|thank you|okay|ok|cool|nice)[!. ]*", lower):
        return "chat"
    if re.search(
        r"\b(no|do not|don't|dont|never)\s+(?:please\s+)?(?:delete|remove|cancel)\b"
        r"|\b(?:cancel|stop)\s+(?:that|it|this)\b"
        r"|\bnever\s*mind\b",
        lower,
    ):
        return "chat"
    if re.search(r"\b(delete|remove)\b", lower):
        return "delete_task"
    if re.search(r"\bcancel\b", lower):
        return "delete_task" if not re.search(r"\b(that|it|this)\b", lower) else "chat"
    if re.match(
        r"^(?:i(?: am|'m)?\s+)?(?:thinking|considering)\s+(?:to|about)\b"
        r"|^maybe\b"
        r"|^should\s+i\b",
        lower,
    ):
        return "productivity_advice"
    if re.search(r"\b(change|move|shift|update)\b", lower):
        return "update_task"
    if re.search(r"\b(add|create|schedule|remind|remember|plan|block|put|set)\b", lower):
        return "create_task"
    if re.match(r"^i\s+(?:need|have|must|will|want|wanna|gotta)\s+to\b", lower):
        return "create_task"
    has_specific_time = bool(re.search(
        r"\b(today|tomorrow|tonight|morning|afternoon|evening|night|"
        r"\d{1,2}(?::\d{2})?\s*(?:am|pm))\b"
        r"|\bat\s+\d{1,2}(?::\d{2})?\b",
        lower,
    ))
    has_specific_date = extract_date_label(lower) is not None
    starts_with_action = bool(re.match(rf"^(?:please\s+)?(?:{TASK_ACTION_PATTERN})\b", lower))
    if starts_with_action and (has_specific_time or has_specific_date):
        return "create_task"
    return "productivity_advice" if re.search(
        r"\b(study|revise|practice|assignment|exam|project|task|meeting|gym|workout)\b",
        lower,
    ) else "chat"


def extract_delete_target(message: str) -> str | None:
    target = normalize_temporal_typos(message).lower()
    target = re.sub(r"^\s*(?:please\s+)?(?:delete|remove|cancel)\s+", "", target)
    target = re.sub(r"\b(?:task|event|reminder)\b", " ", target)
    target = re.sub(r"\s+", " ", target).strip(" .")
    if not target or target in PRONOUN_TITLES:
        return None
    return polish_task_title(target)


def resolve_task_target_from_context(target: str | None, app_context: dict | None) -> str | None:
    tasks = (app_context or {}).get("tasks") or []
    if not tasks:
        return target
    if not target:
        latest = tasks[0] if isinstance(tasks[0], dict) else None
        return latest.get("title") if latest else None
    normalized_target = target.lower().strip()
    best_title = None
    best_score = 0.0
    for task in tasks:
        if not isinstance(task, dict):
            continue
        title = str(task.get("title") or "").strip()
        if not title:
            continue
        normalized_title = title.lower()
        if normalized_target == normalized_title:
            return title
        if normalized_target in normalized_title or normalized_title in normalized_target:
            score = 0.9
        else:
            score = SequenceMatcher(None, normalized_target, normalized_title).ratio()
        if score > best_score:
            best_score = score
            best_title = title
    return best_title if best_score >= 0.58 else target


def fallback_delete_response(
    message: str,
    history: list[dict[str, str]] | None = None,
    app_context: dict | None = None,
) -> dict:
    resolved = resolve_contextual_message(message, history)
    target = resolve_task_target_from_context(extract_delete_target(resolved), app_context)
    target_label = target or "the latest matching task"
    return {
        "title": "Confirm deletion",
        "badge": "Promptly",
        "reasoning": "Deletion is destructive, so Promptly requires confirmation.",
        "content": f"Delete {target_label}?",
        "followUp": "Confirm delete to remove it, or keep it to cancel.",
        "actions": [{"label": "Confirm delete", "tool": "delete_task"}],
        "suggested_tasks": [],
        "schedule_blocks": [],
        "suggested_reminders": [],
        "agent_steps": ["Detected delete intent.", "Resolved the likely task target.", "Paused for confirmation."],
        "model_source": "fallback",
        "intent": "delete_task",
        "confidence": 1.0 if target else 0.65,
        "plan_validated": True,
        "needs_confirmation": True,
        "delete_target": target,
    }


def has_explicit_calendar_intent(message: str) -> bool:
    lower = normalize_temporal_typos(message).strip().lower()
    return bool(re.search(
        r"\b(add|put|create|schedule|block)\b.{0,35}\b(calendar|calender|focus(?:\s+session)?|time\s+block)\b"
        r"|\b(calendar|calender|focus(?:\s+session)?|time\s+block)\b.{0,35}\b(add|put|create|schedule|block)\b"
        r"|\bblock\s+(?:off\s+)?(?:my\s+)?time\b",
        lower,
    ))


def conversational_fallback(message: str) -> dict:
    lower = message.strip().lower()
    if re.fullmatch(r"(hi+|hey+|hello+|yo+|sup)[!. ]*", lower):
        content = "Hey! What are you working on today?"
    elif re.fullmatch(r"(thanks?|thank you)[!. ]*", lower):
        content = "You’re welcome. What should we tackle next?"
    elif re.search(r"\bshould i study\b", lower):
        content = "Yes. Start with one focused 25-minute block, then decide whether to continue based on your energy."
    elif re.search(r"\bhow should i plan\b|\bhelp me plan\b", lower):
        content = "Pick your three most important outcomes, estimate each one, then place the hardest task in your best-energy time."
    else:
        content = "I can help you think it through. Tell me what you’re trying to get done."
    return {
        "title": "Promptly Chat",
        "badge": "Promptly",
        "reasoning": "This is conversation, not a request to create or modify productivity data.",
        "content": content,
        "followUp": "",
        "actions": [],
        "suggested_tasks": [],
        "schedule_blocks": [],
        "suggested_reminders": [],
        "agent_steps": [],
        "model_source": "fallback",
        "intent": "productivity_advice" if re.search(r"\b(study|plan|productive|focus)\b", lower) else "chat",
        "confidence": 1.0,
        "plan_validated": True,
        "needs_confirmation": False,
        "delete_target": None,
    }


def normalize_clock_hour(hour: int, meridiem: str | None, assume_pm: bool = False) -> int:
    if not 0 <= hour <= 23:
        raise ValueError("Hour must be between 0 and 23")
    if meridiem == "pm" and hour < 12:
        return hour + 12
    if meridiem == "am" and hour == 12:
        return 0
    if meridiem is None and assume_pm and 1 <= hour <= 7:
        return hour + 12
    return hour


def format_schedule_hint(day: str, hour: int, minute: int) -> str:
    display_hour = hour % 12 or 12
    suffix = "AM" if hour < 12 else "PM"
    return f"{day} {display_hour}:{minute:02d} {suffix}"


def extract_schedule_hint(message: str) -> tuple[str | None, int, str]:
    lower = normalize_temporal_typos(message).lower()
    date_label = extract_date_label(lower)
    day = date_label or ("Tomorrow" if "tomorrow" in lower else "Today")
    requested_duration = extract_duration_minutes(lower)
    range_match = re.search(
        r"\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(?:-|–|\bto\b)\s*"
        r"(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b",
        lower,
    )

    if range_match:
        start_hour = int(range_match.group(1))
        start_minute = int(range_match.group(2) or 0)
        start_meridiem = range_match.group(3)
        end_hour = int(range_match.group(4))
        end_minute = int(range_match.group(5) or 0)
        end_meridiem = range_match.group(6)
        shared_meridiem = end_meridiem or start_meridiem
        if (
            not shared_meridiem
            and 1 <= start_hour <= 7
            and start_hour < end_hour <= 12
        ):
            shared_meridiem = "pm"
        assume_pm = "evening" in lower or "night" in lower or shared_meridiem == "pm"
        start_hour = normalize_clock_hour(start_hour, start_meridiem or shared_meridiem, assume_pm)
        end_hour = normalize_clock_hour(end_hour, end_meridiem or shared_meridiem, assume_pm)
        start_minutes = start_hour * 60 + start_minute
        end_minutes = end_hour * 60 + end_minute
        if end_minutes <= start_minutes:
            end_minutes += 24 * 60
        duration = max(30, end_minutes - start_minutes)
        return (
            format_schedule_hint(day, start_hour, start_minute),
            duration,
            "high" if day == "Tomorrow" else "medium",
        )

    single_match = re.search(
        r"\b(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b",
        lower,
    )
    if single_match:
        hour = normalize_clock_hour(int(single_match.group(1)), single_match.group(3))
        minute = int(single_match.group(2) or 0)
        return format_schedule_hint(day, hour, minute), requested_duration if requested_duration != 45 else 60, "medium"

    bare_match = re.search(r"\bat\s+(\d{1,2})(?::(\d{2}))?\b", lower)
    if bare_match:
        hour = normalize_clock_hour(int(bare_match.group(1)), None, assume_pm=True)
        minute = int(bare_match.group(2) or 0)
        return format_schedule_hint(day, hour, minute), requested_duration if requested_duration != 45 else 60, "medium"

    if "morning" in lower:
        return f"{day} 9:00 AM", requested_duration if requested_duration != 45 else 60, "medium"
    if "afternoon" in lower:
        return f"{day} 2:00 PM", requested_duration if requested_duration != 45 else 60, "medium"
    if "evening" in lower or "night" in lower or "tonight" in lower:
        return f"{day} 7:00 PM", requested_duration if requested_duration != 45 else 60, "medium"
    if date_label:
        return f"{date_label} 9:00 AM", requested_duration if requested_duration != 45 else 60, "medium"
    return None, requested_duration, "medium"


def build_reminder_candidate(
    message: str,
    history: list[dict[str, str]] | None = None,
) -> dict | None:
    current = normalize_temporal_typos(message).strip()
    combined = current
    time_only = bool(re.fullmatch(
        r"(?:at\s+)?\d{1,2}(?::\d{2})?\s*(?:am|pm)?[.! ]*",
        current,
        re.I,
    ))
    if time_only:
        for item in reversed(history or []):
            if item.get("role") != "user":
                continue
            previous = str(item.get("content") or "").strip()
            if previous and not re.fullmatch(r"(?:at\s+)?\d{1,2}(?::\d{2})?\s*(?:am|pm)?", previous, re.I):
                combined = f"{previous} {current}"
                break

    lower = combined.lower()
    explicit_reminder = has_explicit_reminder_creation_intent(combined) or bool(
        re.search(r"\b(remind|remember|reminder|reminders)\b", lower)
    )
    reminder_action = bool(re.search(
        r"\b(call|email|message|text|pay|buy|take|send|submit|pick up|appointment|medicine|meds)\b",
        lower,
    ))
    has_temporal_hint = bool(re.search(
        r"\b(today|tomorrow|tonight|morning|afternoon|evening|night|"
        r"\d{1,2}(?::\d{2})?\s*(?:am|pm))\b",
        lower,
    ))
    if not explicit_reminder and not (reminder_action and has_temporal_hint):
        return None

    title = extract_task_title(combined)
    if title == "Untitled task":
        return None
    time_hint, _, _ = extract_schedule_hint(combined)
    if not time_hint:
        if "tomorrow" in lower:
            time_hint = "Tomorrow, time not set"
        elif "today" in lower or "tonight" in lower:
            time_hint = "Today, time not set"
        else:
            time_hint = "Time not set"
    return {
        "title": title,
        "time": time_hint,
        "source": "promptly-reminder-proposal",
    }


def reminder_agent_response(candidate: dict) -> dict:
    return {
        "title": "Reminder planned",
        "badge": "Promptly",
        "reasoning": "The request explicitly starts as a reminder, so it must not create a task.",
        "content": f"Added reminder: {candidate['title']}.",
        "followUp": "",
        "actions": [{"label": "Add reminder", "tool": "add_reminder"}],
        "suggested_tasks": [],
        "suggested_reminders": [candidate],
        "schedule_blocks": [],
        "agent_steps": [
            "Detected explicit reminder wording.",
            "Skipped task creation.",
            "Prepared a reminder instead.",
        ],
        "model_source": "deterministic",
        "intent": "create_reminder",
        "confidence": 1.0,
        "plan_validated": True,
        "needs_confirmation": False,
        "delete_target": None,
    }


def smart_single_task_response(message: str, category: str) -> dict:
    title = extract_task_title(message)
    start_hint, duration, priority = extract_schedule_hint(message)
    create_focus_session = bool(start_hint) and has_explicit_calendar_intent(message)
    category_name = category.capitalize()
    response = {
        "title": "Task scheduled",
        "badge": "Promptly",
        "reasoning": "The request contains a task and a usable time window.",
        "content": (
            f"Added {title} to {category_name} and scheduled the requested {duration}-minute focus block."
            if create_focus_session
            else f"Added {title} to {category_name}. No focus session was created."
        ),
        "followUp": (
            f"{title} is placed at {start_hint}. You can drag it to another category if needed."
            if start_hint
            else "Add a time whenever you want it placed on the calendar."
        ),
        "actions": [
            {"label": "Task added", "tool": "task_added"},
            *(
                [{"label": "Focus session added", "tool": "focus_session_added"}]
                if create_focus_session
                else []
            ),
        ],
        "suggested_tasks": [
            {
                "title": title,
                "description": "Created from natural language input.",
                "category": category_name,
                "priority": priority,
                "estimated_time": duration,
                "deadline": start_hint,
            }
        ],
        "schedule_blocks": (
            [{"title": title, "start_hint": start_hint, "duration_minutes": duration}]
            if create_focus_session
            else []
        ),
        "suggested_reminders": [],
        "agent_steps": [],
        "model_source": "fallback",
        "intent": "create_task",
        "confidence": 0.8,
        "plan_validated": True,
        "needs_confirmation": False,
        "delete_target": None,
    }
    response["agent_steps"] = build_agent_steps(message, category_name, response)
    return response


def serialize_user(user: User) -> dict:
    return {
        "id": user.id,
        "name": user.name,
        "email": user.email,
        "preferences": json.loads(user.preferences or "{}"),
        "work_hours": user.work_hours,
        "sleep_time": user.sleep_time,
    }


def user_preferences(user: User) -> dict:
    try:
        return json.loads(user.preferences or "{}")
    except json.JSONDecodeError:
        return {}


def update_user_preferences(user: User, db: Session, updates: dict) -> dict:
    preferences = user_preferences(user)
    preferences.update(updates)
    user.preferences = json.dumps(preferences)
    db.commit()
    db.refresh(user)
    schedule_firebase_sync(firebase_sync_user, user)
    return preferences


def compact_task_context(task: Task | dict) -> dict:
    getter = task.get if isinstance(task, dict) else lambda key, default=None: getattr(task, key, default)
    deadline = getter("deadline")
    return {
        "id": getter("id"),
        "title": getter("title", ""),
        "category": getter("category", ""),
        "priority": getter("priority", ""),
        "status": getter("status", ""),
        "deadline": deadline.isoformat() if isinstance(deadline, datetime) else deadline,
    }


def compact_event_context(event: CalendarEvent | dict) -> dict:
    getter = event.get if isinstance(event, dict) else lambda key, default=None: getattr(event, key, default)
    start_time = getter("start_time")
    end_time = getter("end_time")
    return {
        "id": getter("id"),
        "title": getter("title", ""),
        "task_id": getter("task_id"),
        "start_time": start_time.isoformat() if isinstance(start_time, datetime) else start_time,
        "end_time": end_time.isoformat() if isinstance(end_time, datetime) else end_time,
    }


def build_agent_context(
    user: User | None,
    db: Session,
    payload_context: dict | None = None,
) -> dict:
    payload_context = payload_context or {}
    context = {
        "tasks": [compact_task_context(task) for task in payload_context.get("tasks", [])[:12]],
        "events": [compact_event_context(event) for event in payload_context.get("events", [])[:12]],
        "reminders": payload_context.get("reminders", [])[:8],
    }
    if user:
        tasks = (
            db.query(Task)
            .filter(Task.user_id == user.id, Task.status != "completed")
            .order_by(Task.id.desc())
            .limit(12)
            .all()
        )
        events = (
            db.query(CalendarEvent)
            .filter(CalendarEvent.user_id == user.id)
            .order_by(CalendarEvent.start_time.asc())
            .limit(12)
            .all()
        )
        reminders = (
            db.query(Reminder)
            .filter(Reminder.user_id == user.id)
            .order_by(Reminder.due_at.asc())
            .limit(8)
            .all()
        )
        context = {
            "tasks": [compact_task_context(task) for task in tasks],
            "events": [compact_event_context(event) for event in events],
            "reminders": [
                {
                    "id": reminder.id,
                    "title": reminder.title,
                    "due_at": reminder.due_at.isoformat() if reminder.due_at else None,
                    "status": reminder.status,
                }
                for reminder in reminders
            ],
        }
    return context


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def as_utc(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def is_expired(expires_at: datetime) -> bool:
    return as_utc(expires_at) <= utc_now()


def format_agent_context(app_context: dict | None) -> str:
    app_context = app_context or {}
    lines: list[str] = []
    tasks = app_context.get("tasks") or []
    events = app_context.get("events") or []
    reminders = app_context.get("reminders") or []
    if tasks:
        lines.append("Current active tasks:")
        lines.extend(
            f"- #{task.get('id')}: {task.get('title')} [{task.get('category')}, {task.get('status')}] due {task.get('deadline') or 'none'}"
            for task in tasks[:8]
        )
    if events:
        lines.append("Current calendar/focus events:")
        lines.extend(
            f"- #{event.get('id')}: {event.get('title')} task_id={event.get('task_id') or 'none'} start {event.get('start_time')}"
            for event in events[:8]
        )
    if reminders:
        lines.append("Current reminders:")
        lines.extend(
            f"- #{reminder.get('id')}: {reminder.get('title')} due {reminder.get('due_at') or reminder.get('time') or 'none'}"
            for reminder in reminders[:5]
            if isinstance(reminder, dict)
        )
    return "\n".join(lines) if lines else "No current app context available."


def create_token(user_id: int, db: Session) -> str:
    token = secrets.token_urlsafe(32)
    db.add(AuthSession(
        token=token,
        user_id=user_id,
        expires_at=utc_now() + timedelta(days=30),
    ))
    db.commit()
    return token


def mock_agent_response(message: str, category: str) -> dict:
    """Fallback mock response when API is unavailable"""
    lower_message = message.lower()

    if is_time_correction_message(message):
        return smart_time_correction_response(message, category)

    if "exam" in lower_message or "test" in lower_message:
        return {
            "title": "Study plan generated",
            "badge": "Promptly",
            "reasoning": "Exam prep needs structured time blocks starting with fundamentals.",
            "content": "Week 1: revise foundations and make formula notes.\nWeek 2: solve past papers and mark weak topics.\nWeek 3: mock tests, error log, and final revision.",
            "followUp": "What's your exam date? I can create timed study blocks.",
            "actions": [
                {"label": "Create study tasks", "tool": "create_tasks"},
                {"label": "Schedule blocks", "tool": "schedule_blocks"},
            ],
            "suggested_tasks": [
                {
                    "title": "List exam topics and marks weightage",
                    "description": "Create a quick topic map before studying.",
                    "category": category,
                    "priority": "high",
                    "estimated_time": 30,
                    "deadline": None,
                },
                {
                    "title": "Revise weak topics",
                    "description": "Focus on concepts that repeatedly go wrong in practice.",
                    "category": category,
                    "priority": "high",
                    "estimated_time": 90,
                    "deadline": None,
                },
                {
                    "title": "Attempt one timed mock test",
                    "description": "Simulate exam conditions and log mistakes.",
                    "category": category,
                    "priority": "medium",
                    "estimated_time": 120,
                    "deadline": None,
                },
            ],
            "schedule_blocks": [
                {"title": "Deep study sprint", "start_hint": "Today evening", "duration_minutes": 60},
                {"title": "Practice questions", "start_hint": "Tomorrow morning", "duration_minutes": 45},
                {"title": "Mock test", "start_hint": "Next free slot", "duration_minutes": 120},
            ],
            "agent_steps": [],
            "model_source": "fallback",
        }

    if "project" in lower_message or "assignment" in lower_message:
        return {
            "title": "Project execution plan",
            "badge": "Promptly",
            "reasoning": "Projects move faster when next steps are tiny and visible.",
            "content": "1. Define the output\n2. Create an outline\n3. Build the hardest section first\n4. Polish near deadline",
            "followUp": "What's the deadline? I can break this into smaller milestones.",
            "actions": [
                {"label": "Create milestones", "tool": "create_tasks"},
                {"label": "Schedule time", "tool": "schedule_blocks"},
            ],
            "suggested_tasks": [
                {
                    "title": f"Research for {message[:40]}",
                    "description": "Gather references, articles, and materials.",
                    "category": category,
                    "priority": "high",
                    "estimated_time": 60,
                    "deadline": None,
                },
                {
                    "title": f"Create outline for {message[:40]}",
                    "description": "Structure the main sections and subsections.",
                    "category": category,
                    "priority": "high",
                    "estimated_time": 45,
                    "deadline": None,
                },
                {
                    "title": f"Draft {message[:40]}",
                    "description": "Write the main content.",
                    "category": category,
                    "priority": "medium",
                    "estimated_time": 120,
                    "deadline": None,
                },
                {
                    "title": f"Review & polish {message[:40]}",
                    "description": "Edit, refine, and prepare for submission.",
                    "category": category,
                    "priority": "medium",
                    "estimated_time": 60,
                    "deadline": None,
                },
            ],
            "schedule_blocks": [
                {"title": "Research & outline", "start_hint": "Today evening", "duration_minutes": 90},
                {"title": "First draft", "start_hint": "Tomorrow", "duration_minutes": 120},
                {"title": "Review & polish", "start_hint": "Day before deadline", "duration_minutes": 60},
            ],
            "agent_steps": [],
            "model_source": "fallback",
        }

    if "meeting" in lower_message or "presentation" in lower_message:
        return {
            "title": "Prep blocks found",
            "badge": "Promptly",
            "reasoning": "Presentations need prep time for slides, practice, and Q&A.",
            "content": "1. Organize talking points\n2. Create visuals\n3. Practice with timer\n4. Prepare for questions",
            "followUp": "When is the presentation? I can create focused prep blocks.",
            "actions": [
                {"label": "Create prep tasks", "tool": "create_tasks"},
                {"label": "Block focus time", "tool": "schedule_blocks"},
            ],
            "suggested_tasks": [
                {
                    "title": "Organize talking points",
                    "description": "Structure your main ideas and key messages.",
                    "category": category,
                    "priority": "high",
                    "estimated_time": 45,
                    "deadline": None,
                },
                {
                    "title": "Create/design slides",
                    "description": "Build visuals for your presentation.",
                    "category": category,
                    "priority": "high",
                    "estimated_time": 90,
                    "deadline": None,
                },
                {
                    "title": "Practice presentation",
                    "description": "Do a full run-through with timer.",
                    "category": category,
                    "priority": "medium",
                    "estimated_time": 45,
                    "deadline": None,
                },
            ],
            "schedule_blocks": [
                {"title": "Presentation prep", "start_hint": "Today evening", "duration_minutes": 90},
                {"title": "Create slides", "start_hint": "Tomorrow morning", "duration_minutes": 120},
                {"title": "Practice & refine", "start_hint": "Before presentation", "duration_minutes": 60},
            ],
            "agent_steps": [],
            "model_source": "fallback",
        }

    return smart_single_task_response(message, category)


async def get_agent_response(
    message: str,
    category: str,
    history: list[dict[str, str]] | None = None,
    app_context: dict | None = None,
) -> dict:
    """Get response from Mistral API, Ollama, or fallback to mock."""
    global last_mistral_error
    contextual_message = resolve_contextual_message(message, history)
    normalized_message = normalize_temporal_typos(contextual_message)
    context_summary = format_agent_context(app_context)
    deterministic_intent = classify_request_intent(message)
    actionable_request = deterministic_intent in {"create_task", "update_task", "delete_task"}
    if deterministic_intent == "delete_task":
        fallback = fallback_delete_response(message, history, app_context)
    elif deterministic_intent in {"chat", "productivity_advice"}:
        fallback = conversational_fallback(normalized_message)
        fallback["intent"] = deterministic_intent
    else:
        fallback = mock_agent_response(normalized_message, category)
        fallback["intent"] = deterministic_intent
        fallback["confidence"] = fallback.get("confidence", 0.8)
        fallback["plan_validated"] = True
        fallback["needs_confirmation"] = False
        fallback["delete_target"] = None
    explicit_calendar_intent = has_explicit_calendar_intent(normalized_message)
    parsed_time, parsed_duration, parsed_priority = extract_schedule_hint(normalized_message)
    parsed_title = extract_task_title(normalized_message)
    inferred_task_intent = (
        deterministic_intent == "create_task"
        and not has_explicit_task_creation_intent(normalized_message)
    )
    if inferred_task_intent and fallback.get("suggested_tasks"):
        title = fallback.get("suggested_tasks", [{}])[0].get("title") or parsed_title
        fallback["content"] = f"Add {title} as a task?"
        fallback["followUp"] = "Confirm to add it to your dashboard."
        fallback["actions"] = [{"label": "Add task", "tool": "task_added"}]
        fallback["needs_confirmation"] = True
    if not explicit_calendar_intent:
        fallback["schedule_blocks"] = []
        fallback["actions"] = [
            action
            for action in fallback.get("actions", [])
            if action.get("tool") not in {
                "schedule_blocks",
                "focus_session_added",
                "schedule_time",
            }
        ]
    reminder_candidate = build_reminder_candidate(message, history)
    if has_explicit_reminder_creation_intent(message) and reminder_candidate:
        return reminder_agent_response(reminder_candidate)

    today = datetime.now(APP_TIMEZONE)
    system_prompt = f"""You are the planning layer for Promptly, a productivity assistant.
Return ONLY valid JSON matching this exact structure:
{{
  "intent": "chat|create_task|update_task|delete_task|productivity_advice",
  "confidence": 0.0,
  "task": {{
    "title": "clean actionable title",
    "category": "study|work|personal",
    "priority": "high|medium|low",
    "deadline": "ISO 8601 datetime with timezone offset or null",
    "estimated_minutes": 45
  }} or null,
  "calendar_event": {{
    "should_create": false,
    "start_time": "ISO 8601 datetime with timezone offset or null",
    "end_time": "ISO 8601 datetime with timezone offset or null"
  }} or null,
  "needs_confirmation": false,
  "reply": "short user-facing response"
}}
You are a planner, not a tool executor. Never claim an action happened unless your plan requests it.
Use chat or productivity_advice for greetings, questions, tentative thoughts, and advice.
Use create_task only for a clear commitment or explicit creation/scheduling request.
Use update_task when the user refers to an existing task using context such as "that" or "it".
Use delete_task only for an explicit deletion request and set needs_confirmation true.
Set calendar_event.should_create true ONLY when the user explicitly asks to add to calendar, create a focus session, or block time.
A task deadline or mentioned time alone must not create a calendar event or Focus Session.
Set needs_confirmation true whenever the target, date, or time is materially ambiguous.
Correct typos and remove commands, dates, times, and filler from task.title.
Understand Hinglish and abbreviations. Interpret relative dates in {APP_TIMEZONE.key}.
Current local datetime: {today.isoformat()}. Selected category: {category}.
Use this current Promptly state when resolving references, updates, deletes, and "what next" questions:
{context_summary}
If a request says "that", "it", "latest", or a partial title, resolve it from current tasks/events when possible.
If you cannot resolve the target confidently, ask for confirmation instead of pretending.
Do not include markdown or any keys outside the schema."""

    def merge_model_data(data: dict, model_source: str, default_badge: str) -> dict:
        decision = AgentPlannerDecision.model_validate(data)
        if deterministic_intent == "delete_task":
            result = fallback_delete_response(message, history, app_context)
            result["model_source"] = model_source
            result["content"] = decision.reply or result["content"]
            return result
        if deterministic_intent in {"chat", "productivity_advice"}:
            conversational = conversational_fallback(normalized_message)
            model_reply = decision.reply
            if re.search(
                r"\b(?:added|created|scheduled|saved)\b|\b(?:i(?:'ll| will)|we(?:'ll| will))\s+"
                r"(?:add|create|schedule|save|remind)\b",
                model_reply,
                re.I,
            ):
                model_reply = conversational["content"]
            result = {
                **conversational,
                "title": "Productivity guidance" if deterministic_intent == "productivity_advice" else "Promptly Chat",
                "badge": default_badge,
                "reasoning": f"Validated as {deterministic_intent}; no mutation allowed.",
                "content": model_reply,
                "model_source": model_source,
                "intent": deterministic_intent,
            }
            if reminder_candidate:
                result["content"] = (
                    f"I can add a reminder for {reminder_candidate['title']}."
                )
                result["followUp"] = "Review the reminder details before adding it."
                result["suggested_reminders"] = [reminder_candidate]
                result["actions"] = [{"label": "Add reminder", "tool": "add_reminder"}]
                result["needs_confirmation"] = True
            return result
        if is_time_correction_message(message):
            result = fallback.copy()
            result["model_source"] = model_source
            result["content"] = decision.reply
            return result

        planner_task = decision.task
        if (
            deterministic_intent == "create_task"
            and (decision.intent != "create_task" or planner_task is None)
        ):
            result = fallback.copy()
            result["badge"] = default_badge
            result["model_source"] = model_source
            result["reasoning"] = (
                "The deterministic safety parser recognized a timed action request "
                "and supplied the executable task plan."
            )
            if inferred_task_intent:
                title = result.get("suggested_tasks", [{}])[0].get("title", parsed_title)
                result["content"] = f"Add {title} as a task?"
                result["followUp"] = "Confirm to add it to your dashboard."
                result["actions"] = [{"label": "Add task", "tool": "task_added"}]
                result["needs_confirmation"] = True
            return result
        raw_task_title = normalize_temporal_typos(planner_task.title if planner_task else "")
        task_title = extract_task_title(raw_task_title) if raw_task_title.strip() else parsed_title
        should_apply_plan = (
            deterministic_intent in {"create_task", "update_task"}
            and decision.intent in {"create_task", "update_task"}
            and decision.confidence >= 0.65
            and not decision.needs_confirmation
            and planner_task is not None
        )
        if task_title.lower().strip() in JUNK_TITLES or task_title == "Untitled task":
            should_apply_plan = False
        task_time = planner_task.deadline.isoformat() if planner_task and planner_task.deadline else None
        if parsed_time:
            task_time = parsed_time
        priority = planner_task.priority if planner_task else "medium"
        if parsed_time:
            priority = parsed_priority
        estimated_minutes = planner_task.estimated_minutes if planner_task else 45
        if parsed_time:
            estimated_minutes = parsed_duration

        suggested_tasks = []
        schedule_blocks = []
        if task_title and should_apply_plan:
            suggested_tasks = [{
                "title": task_title,
                "description": "Created by Promptly AI from a validated plan.",
                "category": planner_task.category.capitalize(),
                "priority": priority,
                "estimated_time": estimated_minutes,
                "deadline": task_time,
            }]
            calendar_plan = decision.calendar_event
            if (
                calendar_plan
                and calendar_plan.should_create
                and explicit_calendar_intent
            ):
                duration = max(
                    15,
                    round((calendar_plan.end_time - calendar_plan.start_time).total_seconds() / 60),
                )
                schedule_blocks = [{
                    "title": task_title,
                    "start_hint": parsed_time or calendar_plan.start_time.isoformat(),
                    "duration_minutes": duration,
                }]

        needs_confirmation = decision.needs_confirmation or inferred_task_intent or (
            actionable_request
            and decision.intent in {"create_task", "update_task"}
            and decision.confidence < 0.65
        )
        result = {
            "title": {
                "chat": "Promptly Chat",
                "productivity_advice": "Productivity guidance",
                "create_task": "Task planned",
                "update_task": "Task update planned",
                "delete_task": "Delete request",
            }[decision.intent],
            "badge": default_badge,
            "reasoning": f"Validated planner decision with {decision.confidence:.0%} confidence.",
            "content": (
                f"Add {task_title} as a task?"
                if inferred_task_intent and should_apply_plan
                else f"Added: {task_title}."
                if should_apply_plan
                else decision.reply
            ),
            "followUp": (
                "Confirm to add it to your dashboard."
                if inferred_task_intent and should_apply_plan
                else "Please confirm the missing details."
                if needs_confirmation
                else ""
            ),
            "actions": (
                [{"label": "Add task", "tool": "task_added"}]
                if inferred_task_intent and should_apply_plan
                else fallback["actions"]
                if should_apply_plan
                else []
            ),
            "suggested_tasks": suggested_tasks,
            "suggested_reminders": [],
            "schedule_blocks": schedule_blocks,
            "model_source": model_source,
            "intent": decision.intent,
            "confidence": decision.confidence,
            "plan_validated": True,
            "needs_confirmation": needs_confirmation,
            "delete_target": None,
        }
        if reminder_candidate and not suggested_tasks:
            result["suggested_reminders"] = [reminder_candidate]
            result["actions"] = [{"label": "Add reminder", "tool": "add_reminder"}]
            result["needs_confirmation"] = True
        result["agent_steps"] = (
            build_agent_steps(message, category, result)
            if actionable_request
            else []
        )
        return result

    if MISTRAL_API_KEY:
        try:
            async with httpx.AsyncClient(
                timeout=float(os.getenv("MISTRAL_API_TIMEOUT_SECONDS", "8")),
            ) as client:
                response = await client.post(
                    MISTRAL_API_URL,
                    headers={
                        "Authorization": f"Bearer {MISTRAL_API_KEY}",
                        "Content-Type": "application/json",
                    },
                    json={
                        "model": MISTRAL_API_MODEL,
                        "messages": [
                            {"role": "system", "content": system_prompt},
                            *[
                                {
                                    "role": item.get("role", "user"),
                                    "content": str(item.get("content", ""))[:1000],
                                }
                                for item in (history or [])[-8:]
                                if item.get("role") in {"user", "assistant"} and item.get("content")
                            ],
                            {
                                "role": "user",
                                "content": (
                                    f"Original request: {message}\n"
                                    f"Resolved request: {contextual_message}\n"
                                    f"Normalized temporal wording: {normalized_message}"
                                ),
                            },
                        ],
                        "temperature": 0.2,
                        "max_tokens": 320,
                        "response_format": {"type": "json_object"},
                    },
                )
            response.raise_for_status()
            data = json.loads(response.json()["choices"][0]["message"]["content"])
            last_mistral_error = None
            await asyncio.to_thread(verify_mistral_api_key, True)
            return merge_model_data(data, "mistral_api", "Mistral API")
        except httpx.HTTPStatusError as exc:
            status_code = exc.response.status_code
            body_snippet = exc.response.text[:500].replace("\n", " ")
            logger.warning(
                "Mistral chat completion HTTP %s response: %s",
                status_code,
                body_snippet,
            )
            verification = await asyncio.to_thread(verify_mistral_api_key, True)
            key_is_valid = verification.get("status") == "ok"
            if key_is_valid:
                last_mistral_error = (
                    f"Mistral key is valid, but chat completion failed with HTTP {status_code}. "
                    "Check model/payload."
                )
            elif status_code == 400:
                last_mistral_error = "Mistral rejected the chat model or payload (400)."
            elif status_code == 401:
                last_mistral_error = "Mistral API key is invalid or missing (401)."
            elif status_code == 402:
                last_mistral_error = "Mistral billing or payment is required (402)."
            elif status_code == 429:
                last_mistral_error = "Mistral rate limit or credits were exceeded (429)."
            else:
                last_mistral_error = f"Mistral chat completion returned HTTP {status_code}."
            logger.warning("Mistral API failed: %s", last_mistral_error)
            fallback["model_error"] = last_mistral_error
            if status_code in {400, 401, 402, 403, 429}:
                if reminder_candidate and not fallback.get("suggested_tasks"):
                    fallback["suggested_reminders"] = [reminder_candidate]
                    fallback["actions"] = [{"label": "Add reminder", "tool": "add_reminder"}]
                    fallback["needs_confirmation"] = True
                if actionable_request:
                    fallback["agent_steps"] = build_agent_steps(message, category, fallback)
                return fallback
        except Exception as exc:
            last_mistral_error = f"Mistral API failed: {type(exc).__name__}."
            fallback["model_error"] = last_mistral_error
            logger.warning("%s: %s", last_mistral_error, exc)

    try:
        async with httpx.AsyncClient(
            timeout=float(os.getenv("OLLAMA_TIMEOUT_SECONDS", "3.5")),
        ) as client:
            response = await client.post(
                f"{OLLAMA_BASE_URL}/api/chat",
                json={
                    "model": OLLAMA_MODEL,
                    "stream": False,
                    "format": "json",
                    "options": {
                        "temperature": 0.1,
                        "num_predict": 350,
                        "num_ctx": 2048,
                        "top_p": 0.8,
                    },
                    "messages": [
                        {"role": "system", "content": system_prompt},
                        *[
                            {
                                "role": item.get("role", "user"),
                                "content": str(item.get("content", ""))[:1000],
                            }
                            for item in (history or [])[-8:]
                            if item.get("role") in {"user", "assistant"} and item.get("content")
                        ],
                        {
                            "role": "user",
                            "content": (
                                f"Original request: {message}\n"
                                f"Resolved request: {contextual_message}\n"
                                f"Normalized temporal wording: {normalized_message}"
                            ),
                        },
                    ],
                },
            )
        response.raise_for_status()
        raw_content = response.json()["message"]["content"]
        data = json.loads(raw_content)

        return merge_model_data(data, "mistral", "Mistral")
    except Exception as exc:
        logger.warning("Local Mistral failed: %s: %s", type(exc).__name__, exc)
        if not fallback.get("model_error"):
            fallback["model_error"] = f"Local Mistral unavailable: {type(exc).__name__}."
        if actionable_request:
            fallback["agent_steps"] = build_agent_steps(message, category, fallback)
        if reminder_candidate and not fallback.get("suggested_tasks"):
            fallback["suggested_reminders"] = [reminder_candidate]
            fallback["actions"] = [{"label": "Add reminder", "tool": "add_reminder"}]
            fallback["needs_confirmation"] = True
        return fallback


def get_google_calendar_credentials(
    user: User | None = None,
    db: Session | None = None,
) -> Credentials | None:
    creds = None
    if user:
        token_json = user_preferences(user).get("google_calendar_token")
        if token_json:
            creds = Credentials.from_authorized_user_info(token_json, GOOGLE_CALENDAR_SCOPES)
    elif PUBLIC_BASE_URL:
        return None
    elif GOOGLE_TOKEN_PATH.exists():
        creds = Credentials.from_authorized_user_file(str(GOOGLE_TOKEN_PATH), GOOGLE_CALENDAR_SCOPES)

    if creds and creds.expired and creds.refresh_token:
        creds.refresh(GoogleAuthRequest())
        if user and db:
            update_user_preferences(user, db, {"google_calendar_token": json.loads(creds.to_json())})
        elif not PUBLIC_BASE_URL:
            GOOGLE_TOKEN_PATH.write_text(creds.to_json())
    return creds


def get_google_calendar_service(
    user: User | None = None,
    db: Session | None = None,
):
    creds = get_google_calendar_credentials(user, db)

    if not creds or not creds.valid:
        if not GOOGLE_CREDENTIALS_JSON and not GOOGLE_CREDENTIALS_PATH.exists():
            raise HTTPException(
                status_code=503,
                detail="Google Calendar is not configured. Set GOOGLE_CREDENTIALS_JSON or OAuth client JSON.",
            )
        raise HTTPException(
            status_code=401,
            detail="Google Calendar is not authorized yet. Open /google-calendar/auth-url first.",
        )

    return build("calendar", "v3", credentials=creds)


def google_client_config() -> dict:
    if GOOGLE_CREDENTIALS_JSON:
        try:
            return json.loads(GOOGLE_CREDENTIALS_JSON)
        except json.JSONDecodeError as exc:
            raise HTTPException(status_code=503, detail="GOOGLE_CREDENTIALS_JSON is not valid JSON.") from exc
    if GOOGLE_CREDENTIALS_PATH.exists():
        try:
            return json.loads(GOOGLE_CREDENTIALS_PATH.read_text())
        except json.JSONDecodeError as exc:
            raise HTTPException(status_code=503, detail=f"Google OAuth JSON is invalid at {GOOGLE_CREDENTIALS_PATH}.") from exc
    raise HTTPException(
        status_code=503,
        detail=(
            "Google OAuth is not configured. Set GOOGLE_CREDENTIALS_JSON "
            f"or add OAuth client JSON at {GOOGLE_CREDENTIALS_PATH}."
        ),
    )


def create_google_oauth_flow(
    state: str | None = None,
    scopes: list[str] | None = None,
) -> Flow:
    return Flow.from_client_config(
        google_client_config(),
        scopes=scopes or GOOGLE_CALENDAR_SCOPES,
        redirect_uri=GOOGLE_REDIRECT_URI,
        state=state,
    )


def google_oauth_client_id() -> str:
    try:
        data = google_client_config()
        return data.get("web", {}).get("client_id") or data.get("installed", {}).get("client_id")
    except Exception as exc:
        raise HTTPException(status_code=503, detail="Google OAuth client id is unavailable.") from exc


def frontend_url_from_request(request: Request) -> str:
    allowed_hosts = {"localhost", "127.0.0.1"}
    if PUBLIC_BASE_URL:
        public_host = urlparse(PUBLIC_BASE_URL).hostname
        if public_host:
            allowed_hosts.add(public_host)
    for header_name in ("origin", "referer"):
        header_value = request.headers.get(header_name)
        if not header_value:
            continue
        parsed = urlparse(header_value)
        if parsed.scheme not in {"http", "https"}:
            continue
        if parsed.hostname not in allowed_hosts:
            continue
        port = f":{parsed.port}" if parsed.port else ""
        return f"{parsed.scheme}://{parsed.hostname}{port}/"
    return FRONTEND_REDIRECT_URL


def remember_oauth_frontend_redirect(state: str, request: Request) -> None:
    OAUTH_FRONTEND_REDIRECTS[state] = frontend_url_from_request(request)


def frontend_redirect_with_params(params: dict[str, str], frontend_url: str | None = None) -> str:
    target_url = frontend_url or FRONTEND_REDIRECT_URL
    separator = "&" if "?" in target_url else "?"
    return f"{target_url}{separator}{urlencode(params)}"


def optional_current_user(
    authorization: str | None = Header(default=None),
    db: Session = Depends(get_db),
) -> User | None:
    if not authorization or not authorization.startswith("Bearer "):
        return None

    token = authorization.replace("Bearer ", "", 1)
    auth_session = db.get(AuthSession, token)
    if not auth_session or is_expired(auth_session.expires_at):
        return None
    return db.get(User, auth_session.user_id)


def current_user(
    authorization: str | None = Header(default=None),
    db: Session = Depends(get_db),
) -> User:
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Missing bearer token")

    token = authorization.replace("Bearer ", "", 1)
    auth_session = db.get(AuthSession, token)
    if not auth_session or is_expired(auth_session.expires_at):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token")

    user = db.get(User, auth_session.user_id)
    if not user:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="User not found")
    return user


def current_auth_session(
    authorization: str | None = Header(default=None),
    db: Session = Depends(get_db),
) -> tuple[AuthSession, User]:
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Missing bearer token")

    token = authorization.replace("Bearer ", "", 1)
    auth_session = db.get(AuthSession, token)
    if not auth_session or is_expired(auth_session.expires_at):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token")

    user = db.get(User, auth_session.user_id)
    if not user:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="User not found")
    return auth_session, user


@app.get("/health")
def health():
    return {"status": "ok", "service": "promptly-api", "version": "0.2.0"}


@app.get("/desktop-widget/status")
def desktop_widget_status():
    return desktop_widget_state


@app.post("/desktop-widget/hidden")
async def set_desktop_widget_hidden(request: Request):
    payload = await request.json()
    desktop_widget_state["hidden"] = bool(payload.get("hidden"))
    desktop_widget_state["updated_at"] = utc_now().isoformat()
    return desktop_widget_state


@app.post("/desktop-widget/unhide")
def request_desktop_widget_unhide():
    desktop_widget_state["hidden"] = False
    desktop_widget_state["show_request_id"] += 1
    desktop_widget_state["updated_at"] = utc_now().isoformat()
    return desktop_widget_state


@app.get("/agent/status")
async def agent_status():
    """Report which AI engine Promptly will use."""
    if MISTRAL_API_KEY:
        verification = await asyncio.to_thread(verify_mistral_api_key)
        ready = verification["status"] == "ok"
        return {
            "backend": "online",
            "mistral_api": verification["status"],
            "model": MISTRAL_API_MODEL,
            "model_ready": ready,
            "mode": "mistral_api" if ready else "fallback",
            "last_error": last_mistral_error,
            "key_fingerprint": verification["key_fingerprint"],
            "models_reachable": verification["models_reachable"],
        }

    try:
        async with httpx.AsyncClient(timeout=2) as client:
            response = await client.get(f"{OLLAMA_BASE_URL}/api/tags")
        response.raise_for_status()
        models = response.json().get("models", [])
        model_names = [model.get("name", "") for model in models]
        mistral_ready = any(OLLAMA_MODEL in name for name in model_names)
        return {
            "backend": "online",
            "ollama": "online",
            "model": OLLAMA_MODEL,
            "model_ready": mistral_ready,
            "mode": "mistral" if mistral_ready else "fallback",
        }
    except httpx.HTTPError:
        return {
            "backend": "online",
            "ollama": "offline",
            "model": OLLAMA_MODEL,
            "model_ready": False,
            "mode": "fallback",
        }


@app.get("/agent/mistral/verify")
async def mistral_verify():
    return await asyncio.to_thread(verify_mistral_api_key, force=True)


@app.get("/google-calendar/status")
def google_calendar_status(
    user: User | None = Depends(optional_current_user),
    db: Session = Depends(get_db),
):
    creds = get_google_calendar_credentials(user, db) if user else None
    return {
        "configured": bool(GOOGLE_CREDENTIALS_JSON) or GOOGLE_CREDENTIALS_PATH.exists(),
        "authorized": bool(creds and creds.valid),
        "credentials_path": str(GOOGLE_CREDENTIALS_PATH),
        "token_path": str(GOOGLE_TOKEN_PATH),
        "redirect_uri": GOOGLE_REDIRECT_URI,
    }


@app.get("/google-calendar/auth-url")
def google_calendar_auth_url(
    request: Request,
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
):
    state = secrets.token_urlsafe(24)
    remember_oauth_frontend_redirect(state, request)
    db.add(OAuthState(
        state=state,
        provider="google_calendar",
        user_id=user.id,
        expires_at=utc_now() + timedelta(minutes=10),
    ))
    db.commit()
    flow = create_google_oauth_flow(state=state)
    authorization_url, _ = flow.authorization_url(
        access_type="offline",
        include_granted_scopes="true",
        prompt="consent",
    )
    return {"authorization_url": authorization_url}


@app.get("/auth/google/login-url")
def google_login_url(request: Request, db: Session = Depends(get_db)):
    state = secrets.token_urlsafe(24)
    remember_oauth_frontend_redirect(state, request)
    db.add(OAuthState(
        state=state,
        provider="google_login",
        expires_at=utc_now() + timedelta(minutes=10),
    ))
    db.commit()
    flow = create_google_oauth_flow(state=state, scopes=GOOGLE_LOGIN_SCOPES)
    authorization_url, _ = flow.authorization_url(
        prompt="select_account",
    )
    return {"authorization_url": authorization_url}


@app.get("/auth/google/callback")
@app.get("/auth/google/callback/")
def google_calendar_callback(request: Request, db: Session = Depends(get_db)):
    state = request.query_params.get("state")
    frontend_url = OAUTH_FRONTEND_REDIRECTS.pop(state, FRONTEND_REDIRECT_URL) if state else FRONTEND_REDIRECT_URL
    oauth_state = None
    if state:
        try:
            oauth_state = db.get(OAuthState, state)
        except Exception:
            logger.exception("Could not load Google OAuth state")
            oauth_state = None
    if not oauth_state or is_expired(oauth_state.expires_at):
        if oauth_state:
            db.delete(oauth_state)
            db.commit()
        return RedirectResponse(frontend_redirect_with_params({
            "auth_error": "Invalid or expired Google sign-in. Please try again.",
        }, frontend_url))

    google_error = request.query_params.get("error")
    if google_error:
        db.delete(oauth_state)
        db.commit()
        return RedirectResponse(frontend_redirect_with_params({
            "auth_error": f"Google rejected the sign-in: {google_error}",
        }, frontend_url))

    oauth_provider = oauth_state.provider
    db.delete(oauth_state)
    db.commit()
    try:
        if oauth_provider == "google_login":
            flow = create_google_oauth_flow(state=state, scopes=GOOGLE_LOGIN_SCOPES)
            flow.fetch_token(authorization_response=str(request.url))
            id_info = google_id_token.verify_oauth2_token(
                flow.credentials.id_token,
                GoogleAuthRequest(),
                google_oauth_client_id(),
            )
            email = str(id_info.get("email") or "").strip().lower()
            if not email:
                raise HTTPException(status_code=400, detail="Google account did not include an email.")
            user = db.query(User).filter(User.email == email).first()
            if not user:
                user = User(
                    name=id_info.get("name") or email.split("@")[0],
                    email=email,
                    preferences=json.dumps({
                        "auth_provider": "google",
                        "google_sub": id_info.get("sub"),
                        "picture": id_info.get("picture"),
                    }),
                    work_hours="09:00-17:00",
                    sleep_time="23:00",
                )
                db.add(user)
                db.commit()
                db.refresh(user)
            else:
                preferences = json.loads(user.preferences or "{}")
                preferences.update({
                    "auth_provider": "google",
                    "google_sub": id_info.get("sub") or preferences.get("google_sub"),
                    "picture": id_info.get("picture") or preferences.get("picture"),
                })
                user.name = user.name or id_info.get("name") or email.split("@")[0]
                user.preferences = json.dumps(preferences)
                db.commit()
                db.refresh(user)
            schedule_firebase_sync(firebase_sync_user, user)
            token = create_token(user.id, db)
            return RedirectResponse(frontend_redirect_with_params({
                "auth_token": token,
                "auth_email": user.email,
                "auth_name": user.name,
            }, frontend_url))

        flow = create_google_oauth_flow(state=state)
        flow.fetch_token(authorization_response=str(request.url))
        if oauth_state.user_id:
            calendar_user = db.get(User, oauth_state.user_id)
            if not calendar_user:
                raise HTTPException(status_code=404, detail="OAuth user not found.")
            update_user_preferences(calendar_user, db, {
                "google_calendar_token": json.loads(flow.credentials.to_json()),
            })
        elif not PUBLIC_BASE_URL:
            GOOGLE_TOKEN_PATH.write_text(flow.credentials.to_json())
        else:
            raise HTTPException(status_code=400, detail="Google Calendar OAuth user is missing.")
        return RedirectResponse(frontend_redirect_with_params({"calendar_connected": "1"}, frontend_url))
    except Exception as exc:
        logger.exception("Google auth failed")
        return RedirectResponse(frontend_redirect_with_params({
            "auth_error": (
                f"Google auth failed: {exc}. "
                f"Check Google Cloud redirect URI: {GOOGLE_REDIRECT_URI}"
            ),
        }, frontend_url))


@app.get("/google/callback")
@app.get("/google/callback/")
def google_callback_alias(request: Request, db: Session = Depends(get_db)):
    return google_calendar_callback(request, db)


@app.get("/debug/routes")
def debug_routes():
    return sorted([getattr(route, "path", "") for route in app.routes])


@app.post("/auth/logout", status_code=204)
def logout(
    session_and_user: tuple[AuthSession, User] = Depends(current_auth_session),
    db: Session = Depends(get_db),
):
    auth_session, _user = session_and_user
    db.delete(auth_session)
    db.commit()
    return None


@app.post("/google-calendar/logout")
def google_calendar_logout(
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
):
    if user:
        preferences = user_preferences(user)
        preferences.pop("google_calendar_token", None)
        user.preferences = json.dumps(preferences)
        db.commit()
        schedule_firebase_sync(firebase_sync_user, user)
    elif not PUBLIC_BASE_URL and GOOGLE_TOKEN_PATH.exists():
        GOOGLE_TOKEN_PATH.unlink()
    return {"authorized": False}


@app.get("/google-calendar/events", response_model=list[GoogleCalendarEventOut])
def list_google_calendar_events(
    calendar_id: str = "primary",
    max_results: int = 20,
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
):
    service = get_google_calendar_service(user, db)
    events_result = (
        service.events()
        .list(
            calendarId=calendar_id,
            maxResults=max_results,
            singleEvents=True,
            orderBy="startTime",
            timeMin=utc_now().isoformat().replace("+00:00", "Z"),
        )
        .execute()
    )
    return [
        {
            "id": event["id"],
            "title": event.get("summary", "Untitled event"),
            "start_time": event.get("start", {}).get("dateTime") or event.get("start", {}).get("date"),
            "end_time": event.get("end", {}).get("dateTime") or event.get("end", {}).get("date"),
            "html_link": event.get("htmlLink"),
        }
        for event in events_result.get("items", [])
    ]


@app.post("/google-calendar/events", response_model=GoogleCalendarEventOut)
def create_google_calendar_event(
    payload: GoogleCalendarEventCreate,
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
):
    service = get_google_calendar_service(user, db)
    event = {
        "summary": payload.title,
        "description": payload.description,
        "start": {
            "dateTime": payload.start_time.isoformat(),
            "timeZone": payload.timezone,
        },
        "end": {
            "dateTime": payload.end_time.isoformat(),
            "timeZone": payload.timezone,
        },
        "reminders": {
            "useDefault": False,
            "overrides": [
                {"method": "popup", "minutes": 10},
                {"method": "email", "minutes": 60},
            ],
        },
    }
    created = service.events().insert(calendarId=payload.calendar_id, body=event).execute()
    return {
        "id": created["id"],
        "title": created.get("summary", payload.title),
        "start_time": created.get("start", {}).get("dateTime"),
        "end_time": created.get("end", {}).get("dateTime"),
        "html_link": created.get("htmlLink"),
    }


@app.delete("/google-calendar/events/{event_id}", status_code=204)
def delete_google_calendar_event(
    event_id: str,
    calendar_id: str = "primary",
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
):
    service = get_google_calendar_service(user, db)
    service.events().delete(calendarId=calendar_id, eventId=event_id).execute()
    return None


@app.post("/auth/register", response_model=AuthResponse)
def register(payload: UserCreate, db: Session = Depends(get_db)):
    """Register a new user or get existing user"""
    existing = db.query(User).filter(User.email == payload.email).first()
    if existing:
        return {"token": create_token(existing.id, db), "user": serialize_user(existing)}

    user = User(
        name=payload.name,
        email=payload.email,
        preferences=json.dumps(payload.preferences),
        work_hours=payload.work_hours,
        sleep_time=payload.sleep_time,
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    schedule_firebase_sync(firebase_sync_user, user)
    return {"token": create_token(user.id, db), "user": serialize_user(user)}


@app.post("/auth/login", response_model=AuthResponse)
def login(payload: LoginRequest, db: Session = Depends(get_db)):
    """Login and get auth token"""
    user = db.query(User).filter(User.email == payload.email).first()
    if not user:
        raise HTTPException(status_code=404, detail="User not found. Register first.")
    return {"token": create_token(user.id, db), "user": serialize_user(user)}


@app.post("/auth/desktop", response_model=AuthResponse)
def desktop_session(db: Session = Depends(get_db)):
    """Create a local single-user session for the installed desktop widget."""
    if PUBLIC_BASE_URL and os.getenv("ALLOW_DESKTOP_AUTH", "").lower() not in {"1", "true", "yes"}:
        raise HTTPException(
            status_code=403,
            detail="Desktop session auth is disabled on public deployments. Use Google login.",
        )
    email = "desktop@promptly.app"
    user = db.query(User).filter(User.email == email).first()
    if not user:
        user = User(
            name="Promptly Desktop",
            email=email,
            preferences="{}",
            work_hours="09:00-17:00",
            sleep_time="23:00",
        )
        db.add(user)
        db.commit()
        db.refresh(user)
    schedule_firebase_sync(firebase_sync_user, user)
    for task in db.query(Task).filter(Task.user_id == user.id).all():
        schedule_firebase_sync(firebase_sync_task, task)
    for event in db.query(CalendarEvent).filter(CalendarEvent.user_id == user.id).all():
        schedule_firebase_sync(firebase_sync_calendar_event, event)
    for reminder in db.query(Reminder).filter(Reminder.user_id == user.id).all():
        schedule_firebase_sync(firebase_sync_reminder, reminder)
    return {"token": create_token(user.id, db), "user": serialize_user(user)}


@app.post("/auth/refresh", response_model=AuthResponse)
def refresh_session(
    session_and_user: tuple[AuthSession, User] = Depends(current_auth_session),
    db: Session = Depends(get_db),
):
    """Extend the current bearer token for active desktop/web sessions."""
    auth_session, user = session_and_user
    auth_session.expires_at = utc_now() + timedelta(days=30)
    db.commit()
    return {"token": auth_session.token, "user": serialize_user(user)}


@app.get("/auth/me")
def auth_me(user: User = Depends(current_user)):
    """Return the currently signed-in Promptly user."""
    return serialize_user(user)


@app.get("/firebase/status")
def get_firebase_status():
    """Check whether Firebase Admin/Firestore is configured and reachable."""
    return firebase_status()


@app.post("/firebase/sync")
def sync_current_user_to_firebase(
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
):
    """Queue a one-time Firestore mirror sync for the signed-in user's local data."""
    tasks = db.query(Task).filter(Task.user_id == user.id).all()
    events = db.query(CalendarEvent).filter(CalendarEvent.user_id == user.id).all()
    reminders = db.query(Reminder).filter(Reminder.user_id == user.id).all()
    schedule_firebase_sync(firebase_sync_user, user)
    for task in tasks:
        schedule_firebase_sync(firebase_sync_task, task)
    for event in events:
        schedule_firebase_sync(firebase_sync_calendar_event, event)
    for reminder in reminders:
        schedule_firebase_sync(firebase_sync_reminder, reminder)
    return {
        "queued": True,
        "tasks": len(tasks),
        "calendar_events": len(events),
        "reminders": len(reminders),
    }


@app.post("/tasks", response_model=TaskOut)
def create_task(
    payload: TaskCreate,
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
):
    """Create a new task for the user"""
    task = Task(user_id=user.id, **payload.model_dump())
    db.add(task)
    db.commit()
    db.refresh(task)
    schedule_firebase_sync(firebase_sync_user, user)
    schedule_firebase_sync(firebase_sync_task, task)
    return task


@app.get("/tasks", response_model=list[TaskOut])
def list_tasks(user: User = Depends(current_user), db: Session = Depends(get_db)):
    """Get all tasks for the user"""
    return db.query(Task).filter(Task.user_id == user.id).order_by(Task.deadline.asc()).all()


@app.get("/tasks/prioritize", response_model=list[TaskOut])
def prioritize_tasks(user: User = Depends(current_user), db: Session = Depends(get_db)):
    """Get prioritized tasks"""
    tasks = db.query(Task).filter(Task.user_id == user.id, Task.status != "completed").all()

    def priority_score(task: Task) -> tuple:
        priority_values = {"high": 0, "medium": 1, "low": 2}
        return (
            priority_values.get(task.priority, 1),
            as_utc(task.deadline) if task.deadline else datetime.max.replace(tzinfo=timezone.utc),
            task.estimated_time,
        )

    return sorted(tasks, key=priority_score)


@app.delete("/tasks/{task_id}", status_code=204)
def delete_task_by_id(
    task_id: int,
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
):
    task = db.query(Task).filter(Task.id == task_id, Task.user_id == user.id).first()
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")
    linked_event_ids = [
        event_id for (event_id,) in db.query(CalendarEvent.id).filter(
            CalendarEvent.user_id == user.id,
            CalendarEvent.task_id == task.id,
        ).all()
    ]
    db.query(CalendarEvent).filter(
        CalendarEvent.user_id == user.id,
        CalendarEvent.task_id == task.id,
    ).delete(synchronize_session=False)
    db.delete(task)
    db.commit()
    schedule_firebase_sync(firebase_delete_task, user.id, task_id)
    for event_id in linked_event_ids:
        schedule_firebase_sync(firebase_delete_calendar_event, user.id, event_id)
    return None


@app.patch("/tasks/{task_id}", response_model=TaskOut)
def update_task_by_id(
    task_id: int,
    payload: TaskUpdate,
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
):
    task = db.query(Task).filter(Task.id == task_id, Task.user_id == user.id).first()
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")
    for field, value in payload.model_dump(exclude_unset=True).items():
        setattr(task, field, value)
    db.commit()
    db.refresh(task)
    schedule_firebase_sync(firebase_sync_task, task)
    return task


@app.get("/productivity/priorities")
def productivity_priorities(user: User = Depends(current_user), db: Session = Depends(get_db)):
    """Return scored task priorities with explanations."""
    tasks = db.query(Task).filter(Task.user_id == user.id, Task.status != "completed").all()
    scored = [
        {
            "task": TaskOut.model_validate(task).model_dump(),
            "priority_meta": task_priority_score(task),
        }
        for task in tasks
    ]
    return sorted(scored, key=lambda item: item["priority_meta"]["score"], reverse=True)


@app.get("/briefing/today")
def today_briefing(user: User = Depends(current_user), db: Session = Depends(get_db)):
    """Generate today's AI-style productivity briefing from tasks and calendar events."""
    tasks = db.query(Task).filter(Task.user_id == user.id).all()
    events = db.query(CalendarEvent).filter(CalendarEvent.user_id == user.id).all()
    return build_daily_briefing(tasks, events)


@app.post("/calendar/events", response_model=CalendarEventOut)
def create_calendar_event(
    payload: CalendarEventCreate,
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
):
    """Create a calendar event"""
    if payload.task_id is not None:
        task = db.query(Task).filter(Task.id == payload.task_id, Task.user_id == user.id).first()
        if not task:
            raise HTTPException(status_code=404, detail="Linked task not found")
    event = CalendarEvent(user_id=user.id, **payload.model_dump())
    db.add(event)
    db.commit()
    db.refresh(event)
    sync_agent_event_to_google(event.title, event.start_time, event.end_time)
    schedule_firebase_sync(firebase_sync_calendar_event, event)
    return event


@app.get("/calendar/events", response_model=list[CalendarEventOut])
def list_calendar_events(user: User = Depends(current_user), db: Session = Depends(get_db)):
    """Get all calendar events for the user"""
    return (
        db.query(CalendarEvent)
        .filter(CalendarEvent.user_id == user.id)
        .order_by(CalendarEvent.start_time.asc())
        .all()
    )


@app.delete("/calendar/events/{event_id}", status_code=204)
def delete_calendar_event(
    event_id: int,
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
):
    event = db.query(CalendarEvent).filter(
        CalendarEvent.id == event_id,
        CalendarEvent.user_id == user.id,
    ).first()
    if not event:
        raise HTTPException(status_code=404, detail="Calendar event not found")
    db.delete(event)
    db.commit()
    schedule_firebase_sync(firebase_delete_calendar_event, user.id, event_id)
    return None


@app.post("/reminders", response_model=ReminderOut)
def create_reminder(
    payload: ReminderCreate,
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
):
    reminder = Reminder(user_id=user.id, **payload.model_dump())
    db.add(reminder)
    db.commit()
    db.refresh(reminder)
    schedule_firebase_sync(firebase_sync_reminder, reminder)
    return reminder


@app.get("/reminders", response_model=list[ReminderOut])
def list_reminders(user: User = Depends(current_user), db: Session = Depends(get_db)):
    return (
        db.query(Reminder)
        .filter(Reminder.user_id == user.id)
        .order_by(Reminder.due_at.asc())
        .all()
    )


@app.delete("/reminders/{reminder_id}", status_code=204)
def delete_reminder(
    reminder_id: int,
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
):
    reminder = db.query(Reminder).filter(
        Reminder.id == reminder_id,
        Reminder.user_id == user.id,
    ).first()
    if not reminder:
        raise HTTPException(status_code=404, detail="Reminder not found")
    db.delete(reminder)
    db.commit()
    schedule_firebase_sync(firebase_delete_reminder, user.id, reminder_id)
    return None


def normalize_agent_datetime(value: datetime | str | None) -> datetime | None:
    if value is None:
        return None
    if isinstance(value, datetime):
        parsed = value
    else:
        text = str(value).strip()
        if not text or text.lower() in {"needs date", "none", "null"}:
            return None
        try:
            parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
        except ValueError:
            match = re.search(
                r"\b(today|tomorrow)\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b",
                text,
                re.I,
            )
            month_match = re.search(
                rf"\b({MONTH_PATTERN})\s+(\d{{1,2}})(?:st|nd|rd|th)?\s+"
                r"(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b",
                text,
                re.I,
            )
            now = datetime.now(APP_TIMEZONE)
            if match:
                day_offset = 1 if match.group(1).lower() == "tomorrow" else 0
                hour = normalize_clock_hour(int(match.group(2)), match.group(4).lower())
                parsed = datetime(
                    now.year,
                    now.month,
                    now.day,
                    hour,
                    int(match.group(3) or 0),
                    tzinfo=APP_TIMEZONE,
                ) + timedelta(days=day_offset)
            elif month_match:
                month_lookup = {name: index for index, names in enumerate([
                    ("jan", "january"),
                    ("feb", "february"),
                    ("mar", "march"),
                    ("apr", "april"),
                    ("may",),
                    ("jun", "june"),
                    ("jul", "july"),
                    ("aug", "august"),
                    ("sep", "sept", "september"),
                    ("oct", "october"),
                    ("nov", "november"),
                    ("dec", "december"),
                ], start=1) for name in names}
                month = month_lookup[month_match.group(1).lower()]
                hour = normalize_clock_hour(int(month_match.group(3)), month_match.group(5).lower())
                parsed = datetime(
                    now.year,
                    month,
                    int(month_match.group(2)),
                    hour,
                    int(month_match.group(4) or 0),
                    tzinfo=APP_TIMEZONE,
                )
                if parsed < now:
                    parsed = parsed.replace(year=parsed.year + 1)
            else:
                return None
    if not parsed.tzinfo:
        parsed = parsed.replace(tzinfo=APP_TIMEZONE)
    return parsed.astimezone(APP_TIMEZONE)


def parse_agent_datetime(value: datetime | str | None) -> datetime | None:
    return normalize_agent_datetime(value)


def find_task_by_fuzzy_title(tasks: list[Task], title: str | None) -> Task | None:
    if not tasks:
        return None
    if not title:
        return tasks[0]
    normalized = title.strip().lower()
    best_task = None
    best_score = 0.0
    for task in tasks:
        task_title = task.title.strip().lower()
        if task_title == normalized:
            return task
        if normalized in task_title or task_title in normalized:
            score = 0.92
        else:
            score = SequenceMatcher(None, normalized, task_title).ratio()
        if score > best_score:
            best_score = score
            best_task = task
    return best_task if best_score >= 0.58 else None


def sync_agent_event_to_google(title: str, start_time: datetime, end_time: datetime) -> None:
    if not GOOGLE_TOKEN_PATH.exists():
        return
    try:
        service = get_google_calendar_service()
        service.events().insert(
            calendarId="primary",
            body={
                "summary": title,
                "description": "Created automatically by Promptly.",
                "start": {
                    "dateTime": start_time.isoformat(),
                    "timeZone": APP_TIMEZONE.key,
                },
                "end": {
                    "dateTime": end_time.isoformat(),
                    "timeZone": APP_TIMEZONE.key,
                },
                "extendedProperties": {
                    "private": {"promptlyAgent": "true"},
                },
            },
        ).execute()
    except Exception as exc:
        logger.warning("Google Calendar agent sync failed: %s: %s", type(exc).__name__, exc)


def execute_agent_plan(agent_response: dict, user: User, db: Session) -> tuple[list[Task], list[CalendarEvent]]:
    if not agent_response.get("plan_validated"):
        raise HTTPException(status_code=422, detail="Agent plan failed validation and was not executed.")
    if agent_response.get("needs_confirmation"):
        raise HTTPException(status_code=409, detail="Agent needs confirmation before execution.")
    if agent_response.get("intent") not in {"create_task", "update_task", "delete_task"}:
        raise HTTPException(status_code=422, detail="This agent response does not contain an executable task plan.")

    created_tasks: list[Task] = []
    created_events: list[CalendarEvent] = []
    google_events_to_create: list[tuple[str, datetime, datetime]] = []
    try:
        existing = (
            db.query(Task)
            .filter(Task.user_id == user.id)
            .order_by(Task.id.desc())
            .all()
        )
        if agent_response.get("intent") == "delete_task":
            target = agent_response.get("delete_target")
            if not target:
                raise HTTPException(status_code=409, detail="Confirm which task to delete.")
            matching_task = find_task_by_fuzzy_title(existing, target)
            if not matching_task:
                raise HTTPException(status_code=404, detail="Task not found")
            linked_event_ids = [
                event_id for (event_id,) in db.query(CalendarEvent.id).filter(
                    CalendarEvent.user_id == user.id,
                    CalendarEvent.task_id == matching_task.id,
                ).all()
            ]
            db.query(CalendarEvent).filter(
                CalendarEvent.user_id == user.id,
                CalendarEvent.task_id == matching_task.id,
            ).delete(synchronize_session=False)
            db.delete(matching_task)
            db.commit()
            schedule_firebase_sync(firebase_delete_task, user.id, matching_task.id)
            for event_id in linked_event_ids:
                schedule_firebase_sync(firebase_delete_calendar_event, user.id, event_id)
            return [], []

        for raw_task in agent_response.get("suggested_tasks", [])[:5]:
            suggestion = AgentTaskSuggestion.model_validate(raw_task)
            deadline = parse_agent_datetime(suggestion.deadline)
            active_existing = [task for task in existing if task.status != "completed"]
            matching_task = find_task_by_fuzzy_title(active_existing, suggestion.title)
            if agent_response.get("intent") == "update_task":
                if not matching_task:
                    raise HTTPException(status_code=404, detail="Task to update not found")
                if suggestion.description:
                    matching_task.description = suggestion.description
                if deadline is not None:
                    matching_task.deadline = deadline
                if suggestion.category:
                    matching_task.category = suggestion.category.lower()
                if suggestion.priority:
                    matching_task.priority = suggestion.priority
                if suggestion.estimated_time:
                    matching_task.estimated_time = suggestion.estimated_time
                task = matching_task
            else:
                task = Task(
                    user_id=user.id,
                    title=suggestion.title,
                    description=suggestion.description,
                    deadline=deadline,
                    category=suggestion.category.lower(),
                    priority=suggestion.priority,
                    estimated_time=suggestion.estimated_time,
                    status="todo",
                )
                db.add(task)
            created_tasks.append(task)

        db.flush()
        tasks_by_title = {
            task.title.strip().lower(): task
            for task in created_tasks
            if task.id is not None
        }

        for raw_block in agent_response.get("schedule_blocks", [])[:5]:
            block = AgentScheduleBlock.model_validate(raw_block)
            normalized_start = normalize_agent_datetime(block.start_hint)
            if not normalized_start:
                continue
            normalized_end = normalized_start + timedelta(minutes=block.duration_minutes)
            start_time = normalized_start
            end_time = normalized_end
            linked_task = tasks_by_title.get(block.title.strip().lower())
            duplicate = (
                db.query(CalendarEvent)
                .filter(
                    CalendarEvent.user_id == user.id,
                    CalendarEvent.title == block.title,
                    CalendarEvent.start_time == start_time,
                )
                .first()
            )
            if duplicate:
                duplicate.end_time = end_time
                if linked_task and duplicate.task_id is None:
                    duplicate.task_id = linked_task.id
                event = duplicate
            else:
                event = CalendarEvent(
                    user_id=user.id,
                    task_id=linked_task.id if linked_task else None,
                    title=block.title,
                    start_time=start_time,
                    end_time=end_time,
                )
                db.add(event)
                google_events_to_create.append((block.title, normalized_start, normalized_end))
            created_events.append(event)

        db.commit()
        for item in [*created_tasks, *created_events]:
            db.refresh(item)
        schedule_firebase_sync(firebase_sync_user, user)
        for task in created_tasks:
            schedule_firebase_sync(firebase_sync_task, task)
        for event in created_events:
            schedule_firebase_sync(firebase_sync_calendar_event, event)
        for title, start_time, end_time in google_events_to_create:
            sync_agent_event_to_google(title, start_time, end_time)
        return created_tasks, created_events
    except HTTPException:
        db.rollback()
        raise
    except Exception as exc:
        db.rollback()
        logger.exception("Agent plan execution failed")
        raise HTTPException(status_code=500, detail="Agent plan could not be executed.") from exc


def execute_agent_reminders(agent_response: dict, user: User, db: Session) -> list[Reminder]:
    if agent_response.get("intent") != "create_reminder":
        return []
    if not agent_response.get("plan_validated"):
        raise HTTPException(status_code=422, detail="Agent reminder plan failed validation.")
    if agent_response.get("needs_confirmation"):
        raise HTTPException(status_code=409, detail="Agent needs confirmation before creating a reminder.")

    created_reminders: list[Reminder] = []
    try:
        for raw_reminder in agent_response.get("suggested_reminders", [])[:5]:
            if not isinstance(raw_reminder, dict):
                continue
            title = str(raw_reminder.get("title") or raw_reminder.get("text") or "").strip()
            if not title:
                continue
            due_at = parse_agent_datetime(
                raw_reminder.get("due_at")
                or raw_reminder.get("time")
                or raw_reminder.get("due")
                or raw_reminder.get("when")
            )
            reminder = Reminder(
                user_id=user.id,
                title=title[:180],
                due_at=due_at,
                status="pending",
            )
            db.add(reminder)
            created_reminders.append(reminder)
        if not created_reminders:
            return []
        db.commit()
        for reminder in created_reminders:
            db.refresh(reminder)
            schedule_firebase_sync(firebase_sync_reminder, reminder)
        return created_reminders
    except Exception as exc:
        db.rollback()
        logger.exception("Agent reminder execution failed")
        raise HTTPException(status_code=500, detail="Agent reminder could not be executed.") from exc


def planner_schema_prompt() -> str:
    return """Return exactly one JSON object:
{
  "intent": "chat | create_task | update_task | delete_task | productivity_advice",
  "confidence": 0.0,
  "task": {
    "title": "short actionable task title",
    "category": "study | work | personal",
    "priority": "high | medium | low",
    "deadline": "ISO 8601 datetime with timezone offset, or null",
    "estimated_minutes": 45
  } or null,
  "calendar_event": {
    "should_create": false,
    "start_time": "ISO 8601 datetime with timezone offset, or null",
    "end_time": "ISO 8601 datetime with timezone offset, or null"
  } or null,
  "delete_target": "task title to delete, or null",
  "needs_confirmation": false,
  "reply": "short user-facing reply"
}
Examples:
- "study at 7" -> intent=create_task, task.title="study", deadline=today at 7 PM, calendar_event.should_create=false, needs_confirmation=true.
- "add focus session for study from 7 to 8pm" -> intent=create_task, task title study, calendar_event.should_create=true with start/end.
- "move call mom to tomorrow 3pm" -> intent=update_task and resolve title from current tasks.
- "delete call mom" -> intent=delete_task, needs_confirmation=true."""


def build_planner_system_prompt(user: User | None, tasks: list[Task], events: list[CalendarEvent]) -> str:
    now = datetime.now(APP_TIMEZONE)
    active_tasks = [task for task in tasks if task.status != "completed"]
    scored = sorted(
        [(task, task_priority_score(task, now)) for task in active_tasks],
        key=lambda item: item[1]["score"],
        reverse=True,
    )
    overdue = [item for item in scored if item[1]["overdue"]]
    due_soon = [
        item for item in scored
        if not item[1]["overdue"] and item[1]["hours_until_deadline"] <= 24
    ]
    today_events = [
        event for event in events
        if as_utc(event.start_time).astimezone(APP_TIMEZONE).date() == now.date()
    ]
    top_task_lines = [
        f"- {task.title} [{task.category}, {task.priority}] score={meta['score']} due={task.deadline or 'none'}"
        for task, meta in scored[:5]
    ] or ["- none"]
    work_hours = user.work_hours if user else "09:00-17:00"
    sleep_time = user.sleep_time if user else "23:00"
    return f"""You are Promptly's planner layer. You plan only; tools execute later.
Current datetime: {now.isoformat()} ({APP_TIMEZONE.key})
User preferences: work_hours={work_hours}, sleep_time={sleep_time}
Top 5 tasks by priority:
{chr(10).join(top_task_lines)}
Overdue task count: {len(overdue)}
Tasks due in next 24 hours: {len(due_soon)}
Today's calendar event count: {len(today_events)}

Rules:
- Return JSON only. No markdown.
- Never claim an action happened. Say what should happen or ask confirmation.
- A time/deadline alone creates a task deadline, not a calendar/focus event.
- Create calendar_event only when the user explicitly asks for focus session, calendar, block time, or schedule block.
- For destructive actions, set delete_target and needs_confirmation=true.
- If target/date/time is ambiguous, set needs_confirmation=true.
- Use current task context to resolve partial titles and "that/it/latest".

Schema:
{planner_schema_prompt()}"""


async def call_mistral_planner(messages: list[dict[str, str]]) -> dict:
    if not MISTRAL_API_KEY:
        raise RuntimeError("Mistral API key is missing")
    timeout = float(os.getenv("MISTRAL_TIMEOUT", os.getenv("MISTRAL_API_TIMEOUT_SECONDS", "8")))
    retry_statuses = {429, 500, 502, 503, 504}
    last_exc: Exception | None = None
    async with httpx.AsyncClient(timeout=timeout) as client:
        for attempt in range(3):
            try:
                response = await client.post(
                    MISTRAL_API_URL,
                    headers={"Authorization": f"Bearer {MISTRAL_API_KEY}"},
                    json={
                        "model": MISTRAL_API_MODEL,
                        "messages": messages,
                        "response_format": {"type": "json_object"},
                        "temperature": 0.3,
                        "max_tokens": 800,
                    },
                )
                if response.status_code in retry_statuses and attempt < 2:
                    await asyncio.sleep(1)
                    continue
                response.raise_for_status()
                return json.loads(response.json()["choices"][0]["message"]["content"])
            except (httpx.TimeoutException, httpx.HTTPError, KeyError, json.JSONDecodeError) as exc:
                last_exc = exc
                status_code = exc.response.status_code if isinstance(exc, httpx.HTTPStatusError) else None
                if status_code in retry_statuses and attempt < 2:
                    await asyncio.sleep(1)
                    continue
                break
    raise RuntimeError(f"Mistral unavailable: {type(last_exc).__name__ if last_exc else 'unknown'}")


def sanitize_planner_payload(data: dict) -> dict:
    calendar_event = data.get("calendar_event")
    if isinstance(calendar_event, dict) and calendar_event.get("should_create"):
        if not calendar_event.get("start_time") or not calendar_event.get("end_time"):
            calendar_event["should_create"] = False
            calendar_event["start_time"] = None
            calendar_event["end_time"] = None
    return data


def planner_decision_to_agent_response(
    decision: AgentPlannerDecision,
    model_source: str,
    warning: str | None = None,
) -> dict:
    suggested_tasks = []
    schedule_blocks = []
    if decision.task:
        suggested_tasks.append({
            "title": decision.task.title,
            "description": "Created from a validated Promptly agent plan.",
            "category": decision.task.category.capitalize(),
            "priority": decision.task.priority,
            "estimated_time": decision.task.estimated_minutes,
            "deadline": decision.task.deadline,
        })
    if decision.calendar_event and decision.calendar_event.should_create:
        duration = max(
            1,
            round((decision.calendar_event.end_time - decision.calendar_event.start_time).total_seconds() / 60),
        )
        title = decision.task.title if decision.task else "Focus session"
        schedule_blocks.append({
            "title": title,
            "start_hint": decision.calendar_event.start_time.isoformat(),
            "duration_minutes": duration,
        })
    actions = []
    if decision.intent in {"create_task", "update_task"} and suggested_tasks:
        actions.append({"label": "Add task" if decision.intent == "create_task" else "Update task", "tool": "task_added"})
    if schedule_blocks:
        actions.append({"label": "Add focus session", "tool": "focus_session_added"})
    if decision.intent == "delete_task":
        actions.append({"label": "Confirm delete", "tool": "delete_task"})
    delete_target = decision.delete_target
    if decision.intent == "delete_task" and not delete_target and decision.task:
        delete_target = decision.task.title
    return {
        "title": {
            "chat": "Promptly Chat",
            "create_task": "Task planned",
            "update_task": "Task update planned",
            "delete_task": "Delete request",
            "productivity_advice": "Productivity guidance",
        }[decision.intent],
        "badge": "Promptly",
        "model_source": model_source,
        "intent": decision.intent,
        "confidence": decision.confidence,
        "plan_validated": True,
        "needs_confirmation": decision.needs_confirmation,
        "delete_target": delete_target,
        "reasoning": "Validated planner decision with deterministic Python checks.",
        "content": f"{decision.reply}{' ' + warning if warning else ''}".strip(),
        "followUp": "Confirm to continue." if decision.needs_confirmation else "",
        "agent_steps": ["Planner produced JSON.", "Validator checked confidence, task payload, calendar window, and dates."],
        "actions": actions,
        "suggested_tasks": suggested_tasks,
        "suggested_reminders": [],
        "schedule_blocks": schedule_blocks,
    }


def validate_planner_decision(data: dict) -> tuple[AgentPlannerDecision, str | None]:
    decision = AgentPlannerDecision.model_validate(sanitize_planner_payload(data))
    warning = None
    if decision.confidence < 0.55:
        decision.needs_confirmation = True
    if decision.intent in {"create_task", "update_task"} and decision.task is None:
        raise ValueError("Task is required for task intents")
    if decision.intent == "delete_task" and not (decision.delete_target or (decision.task and decision.task.title)):
        raise ValueError("delete_target is required for delete_task")
    if decision.calendar_event and decision.calendar_event.should_create:
        if not decision.calendar_event.start_time or not decision.calendar_event.end_time:
            decision.calendar_event.should_create = False
    if decision.task and decision.task.deadline and as_utc(decision.task.deadline) < utc_now():
        decision.needs_confirmation = True
        warning = "The deadline appears to be in the past; please confirm."
    logger.info(
        "Agent plan validation: intent=%s confidence=%.2f needs_confirmation=%s",
        decision.intent,
        decision.confidence,
        decision.needs_confirmation,
    )
    return decision, warning


async def get_agent_response_async(
    message: str,
    category: str,
    history: list[dict[str, str]] | None,
    app_context: dict,
    user: User | None,
    tasks: list[Task],
    events: list[CalendarEvent],
) -> dict:
    fallback = await get_agent_response(message, category, history, app_context)
    if fallback.get("intent") == "create_reminder":
        return fallback
    fallback["model_error"] = fallback.get("model_error") or "Mistral unavailable"
    try:
        system_prompt = build_planner_system_prompt(user, tasks, events)
        messages = [
            {"role": "system", "content": system_prompt},
            *[
                {"role": item.get("role", "user"), "content": str(item.get("content", ""))[:1000]}
                for item in (history or [])[-6:]
                if item.get("role") in {"user", "assistant"} and item.get("content")
            ],
            {"role": "user", "content": message},
        ]
        raw_plan = await call_mistral_planner(messages)
        decision, warning = validate_planner_decision(raw_plan)
        return planner_decision_to_agent_response(decision, "mistral_api", warning)
    except Exception as exc:
        logger.warning("Async agent planner fell back: %s: %s", type(exc).__name__, exc)
        return fallback


def webhook_plan_to_agent_response(plan: AgentPlannerDecision) -> dict:
    suggested_tasks = []
    schedule_blocks = []
    if plan.task:
        suggested_tasks.append({
            "title": plan.task.title,
            "description": "",
            "category": plan.task.category,
            "priority": plan.task.priority,
            "estimated_time": plan.task.estimated_minutes,
            "deadline": plan.task.deadline,
        })
    if plan.calendar_event and plan.calendar_event.should_create:
        duration_minutes = max(
            1,
            int(
                (
                    plan.calendar_event.end_time
                    - plan.calendar_event.start_time
                ).total_seconds() // 60
            ),
        )
        schedule_blocks.append({
            "title": plan.task.title if plan.task else "Promptly focus session",
            "start_hint": plan.calendar_event.start_time.isoformat(),
            "duration_minutes": duration_minutes,
        })
    return {
        "intent": plan.intent,
        "confidence": plan.confidence,
        "plan_validated": True,
        "needs_confirmation": plan.needs_confirmation,
        "delete_target": plan.delete_target or (plan.task.title if plan.task else None),
        "suggested_tasks": suggested_tasks,
        "schedule_blocks": schedule_blocks,
    }


async def generate_digest_message(digest_payload: dict) -> str:
    fallback = "Start with the highest-pressure task, then protect one focused work block."
    if not MISTRAL_API_KEY:
        return fallback
    messages = [
        {
            "role": "system",
            "content": (
                "You are Promptly's digest writer. Return one concise action plan sentence. "
                "Do not invent tasks, habits, or events."
            ),
        },
        {"role": "user", "content": json.dumps(digest_payload, default=str)[:4000]},
    ]
    try:
        async with httpx.AsyncClient(timeout=8) as client:
            for attempt in range(3):
                response = await client.post(
                    MISTRAL_API_URL,
                    headers={"Authorization": f"Bearer {MISTRAL_API_KEY}"},
                    json={
                        "model": MISTRAL_API_MODEL,
                        "messages": messages,
                        "temperature": 0.25,
                        "max_tokens": 120,
                    },
                )
                if response.status_code in {429, 500, 502, 503, 504} and attempt < 2:
                    await asyncio.sleep(1)
                    continue
                response.raise_for_status()
                message = response.json()["choices"][0]["message"]["content"].strip()
                return message or fallback
    except Exception as exc:
        logger.warning("Digest Mistral call fell back: %s: %s", type(exc).__name__, exc)
    return fallback


def build_recommendation_context(
    user: User,
    tasks: list[Task],
    events: list[CalendarEvent],
    reminders: list[Reminder],
) -> dict:
    now = datetime.now(APP_TIMEZONE)
    active_tasks = [task for task in tasks if task.status != "completed"]
    completed_tasks = [task for task in tasks if task.status == "completed"]
    scored = sorted(
        [
            {
                "id": task.id,
                "title": task.title,
                "category": task.category,
                "priority": task.priority,
                "status": task.status,
                "estimated_time": task.estimated_time,
                "deadline": task.deadline.isoformat() if task.deadline else None,
                "priority_meta": task_priority_score(task, now),
            }
            for task in active_tasks
        ],
        key=lambda item: item["priority_meta"]["score"],
        reverse=True,
    )
    today_events = [
        event for event in events
        if as_utc(event.start_time).astimezone(APP_TIMEZONE).date() == now.date()
    ]
    return {
        "current_datetime": now.isoformat(),
        "timezone": APP_TIMEZONE.key,
        "user_preferences": {
            "work_hours": user.work_hours,
            "sleep_time": user.sleep_time,
        },
        "summary": {
            "active_task_count": len(active_tasks),
            "completed_task_count": len(completed_tasks),
            "overdue_count": sum(1 for item in scored if item["priority_meta"]["overdue"]),
            "due_24h_count": sum(
                1 for item in scored
                if not item["priority_meta"]["overdue"]
                and item["priority_meta"]["hours_until_deadline"] <= 24
            ),
            "today_calendar_count": len(today_events),
            "pending_reminder_count": sum(1 for reminder in reminders if reminder.status != "completed"),
            "estimated_workload_minutes": sum(task.estimated_time or 45 for task in active_tasks),
        },
        "top_tasks": scored[:8],
        "today_events": [
            {
                "id": event.id,
                "title": event.title,
                "task_id": event.task_id,
                "start_time": event.start_time.isoformat(),
                "end_time": event.end_time.isoformat(),
            }
            for event in today_events[:8]
        ],
        "upcoming_events": [
            {
                "id": event.id,
                "title": event.title,
                "task_id": event.task_id,
                "start_time": event.start_time.isoformat(),
                "end_time": event.end_time.isoformat(),
            }
            for event in events[:12]
        ],
        "reminders": [
            {
                "id": reminder.id,
                "title": reminder.title,
                "due_at": reminder.due_at.isoformat() if reminder.due_at else None,
                "status": reminder.status,
            }
            for reminder in reminders[:10]
        ],
    }


def deterministic_recommendations(context: dict) -> dict:
    summary = context["summary"]
    top_tasks = context["top_tasks"]
    recommendations = []
    if summary["overdue_count"]:
        recommendations.append({
            "title": "Recover overdue work first",
            "reason": f"{summary['overdue_count']} task(s) are overdue, so your plan should start with damage control.",
            "action": "Pick the most overdue high-priority item and either finish it or reschedule it today.",
            "impact": "high",
        })
    if summary["estimated_workload_minutes"] > 360:
        recommendations.append({
            "title": "Reduce today's workload",
            "reason": "The active workload is too large for one focused day.",
            "action": "Keep the top 2 tasks for today and move the rest out of the way.",
            "impact": "high",
        })
    if top_tasks:
        recommendations.append({
            "title": "Protect one focus block",
            "reason": f"{top_tasks[0]['title']} has the highest combined urgency and effort score.",
            "action": f"Block 50 minutes for {top_tasks[0]['title']} before checking lower-priority work.",
            "impact": "medium",
        })
    if summary["today_calendar_count"] >= 4:
        recommendations.append({
            "title": "Defend transition time",
            "reason": "A packed calendar increases context switching.",
            "action": "Leave 10 minutes between events and avoid adding optional focus sessions today.",
            "impact": "medium",
        })
    if not recommendations:
        recommendations.append({
            "title": "Use the clean slate",
            "reason": "No urgent pressure is visible right now.",
            "action": "Choose one meaningful task and finish it before adding more.",
            "impact": "medium",
        })
    return {
        "model_source": "deterministic",
        "efficiency_score": max(35, min(95, 90 - summary["overdue_count"] * 12 - max(0, summary["estimated_workload_minutes"] - 300) // 20)),
        "agent_message": "I analyzed tasks, calendar, reminders, deadlines, and workload to find the highest-leverage changes.",
        "recommendations": recommendations[:5],
        "risks": [
            "Overdue work will keep compounding." if summary["overdue_count"] else "",
            "Too many active tasks can split attention." if summary["active_task_count"] > 6 else "",
            "Calendar density may reduce deep work." if summary["today_calendar_count"] >= 4 else "",
        ],
        "next_actions": [
            recommendation["action"] for recommendation in recommendations[:3]
        ],
        "context_summary": summary,
    }


async def generate_ai_recommendations(context: dict) -> dict:
    fallback = deterministic_recommendations(context)
    if not MISTRAL_API_KEY:
        return fallback
    system_prompt = """You are Promptly's efficiency strategist.
Analyze the entire productivity state: tasks, deadlines, categories, calendar events, reminders, workload, and user preferences.
Return JSON only with this shape:
{
  "efficiency_score": 0-100,
  "agent_message": "short direct summary",
  "recommendations": [
    {"title": "...", "reason": "...", "action": "...", "impact": "high|medium|low"}
  ],
  "risks": ["..."],
  "next_actions": ["..."]
}
Be specific to the user's actual data. Do not invent tasks or events. Prefer fewer, sharper recommendations over generic advice."""
    try:
        async with httpx.AsyncClient(timeout=8) as client:
            response = await client.post(
                MISTRAL_API_URL,
                headers={"Authorization": f"Bearer {MISTRAL_API_KEY}"},
                json={
                    "model": MISTRAL_API_MODEL,
                    "messages": [
                        {"role": "system", "content": system_prompt},
                        {"role": "user", "content": json.dumps(context, default=str)[:7000]},
                    ],
                    "response_format": {"type": "json_object"},
                    "temperature": 0.25,
                    "max_tokens": 900,
                },
            )
        response.raise_for_status()
        data = json.loads(response.json()["choices"][0]["message"]["content"])
        return {
            "model_source": "mistral_api",
            "efficiency_score": max(0, min(100, int(data.get("efficiency_score", fallback["efficiency_score"])))),
            "agent_message": data.get("agent_message") or fallback["agent_message"],
            "recommendations": data.get("recommendations") or fallback["recommendations"],
            "risks": data.get("risks") or fallback["risks"],
            "next_actions": data.get("next_actions") or fallback["next_actions"],
            "context_summary": context["summary"],
        }
    except Exception as exc:
        logger.warning("AI recommendations fell back: %s: %s", type(exc).__name__, exc)
        fallback["model_error"] = f"{type(exc).__name__}"
        return fallback


@app.post("/webhooks/n8n")
def receive_n8n_webhook(
    payload: N8nWebhookRequest,
    x_n8n_webhook_secret: str | None = Header(default=None, alias="X-N8N-Webhook-Secret"),
    db: Session = Depends(get_db),
):
    """Execute a validated n8n agent plan through Promptly's normal action pipeline."""
    if not N8N_WEBHOOK_SECRET:
        raise HTTPException(status_code=503, detail="n8n webhook is not configured.")
    if not x_n8n_webhook_secret or not hmac.compare_digest(
        x_n8n_webhook_secret,
        N8N_WEBHOOK_SECRET,
    ):
        raise HTTPException(status_code=401, detail="Invalid n8n webhook secret.")
    if payload.plan.needs_confirmation:
        raise HTTPException(status_code=409, detail="Webhook plan still needs confirmation.")
    if payload.plan.confidence < 0.65:
        raise HTTPException(status_code=422, detail="Webhook plan confidence is too low.")

    user = db.query(User).filter(User.id == payload.user_id).first()
    if not user:
        raise HTTPException(status_code=404, detail="User not found.")

    agent_response = webhook_plan_to_agent_response(payload.plan)
    created_tasks, created_events = execute_agent_plan(agent_response, user, db)
    return {
        "status": "executed",
        "created_tasks": [TaskOut.model_validate(task).model_dump() for task in created_tasks],
        "created_events": [
            CalendarEventOut.model_validate(event).model_dump()
            for event in created_events
        ],
    }


@app.post("/agent/run", response_model=AgentResponse)
async def run_agent(
    payload: AgentRequest,
    user: User | None = Depends(optional_current_user),
    db: Session = Depends(get_db),
):
    """Run Promptly with optional user context; anonymous calls return suggestions only."""
    app_context = build_agent_context(user, db, payload.app_context)
    context_tasks: list[Task] = []
    context_events: list[CalendarEvent] = []
    if user:
        context_tasks = (
            db.query(Task)
            .filter(Task.user_id == user.id)
            .order_by(Task.deadline.asc(), Task.id.desc())
            .all()
        )
        context_events = (
            db.query(CalendarEvent)
            .filter(CalendarEvent.user_id == user.id)
            .order_by(CalendarEvent.start_time.asc())
            .all()
        )
    agent_response = await get_agent_response_async(
        payload.message,
        payload.category,
        payload.history,
        app_context,
        user,
        context_tasks,
        context_events,
    )
    created_tasks: list[Task] = []
    created_events: list[CalendarEvent] = []
    created_reminders: list[Reminder] = []
    if payload.auto_create_tasks:
        if not user:
            raise HTTPException(status_code=401, detail="Sign in before enabling automatic agent actions.")
        if agent_response.get("intent") == "create_reminder" and not agent_response.get("needs_confirmation"):
            created_reminders = execute_agent_reminders(agent_response, user, db)
        elif (
            agent_response.get("intent") in {"create_task", "update_task", "delete_task"}
            and not agent_response.get("needs_confirmation")
        ):
            created_tasks, created_events = execute_agent_plan(agent_response, user, db)

    return {
        "title": agent_response.get("title", "Plan ready"),
        "badge": agent_response.get("badge", "Promptly"),
        "model_source": agent_response.get("model_source", "fallback"),
        "model_error": agent_response.get("model_error"),
        "intent": agent_response.get("intent", "chat"),
        "confidence": agent_response.get("confidence", 0),
        "plan_validated": agent_response.get("plan_validated", False),
        "needs_confirmation": agent_response.get("needs_confirmation", False),
        "delete_target": agent_response.get("delete_target"),
        "reasoning": agent_response.get("reasoning", ""),
        "content": agent_response.get("content", "I understood your request."),
        "followUp": agent_response.get("followUp", ""),
        "agent_steps": agent_response.get("agent_steps", []),
        "actions": agent_response.get("actions", []),
        "suggested_tasks": agent_response.get("suggested_tasks", []),
        "suggested_reminders": agent_response.get("suggested_reminders", []),
        "schedule_blocks": agent_response.get("schedule_blocks", []),
        "created_tasks": [TaskOut.model_validate(task).model_dump() for task in created_tasks],
        "created_events": [
            CalendarEventOut.model_validate(event).model_dump()
            for event in created_events
        ],
        "created_reminders": [
            ReminderOut.model_validate(reminder).model_dump()
            for reminder in created_reminders
        ],
    }


@app.get("/agent/digest")
async def get_agent_digest(
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
):
    """Return a compact, actionable daily agent digest for the signed-in user."""
    now = utc_now()
    next_day = now + timedelta(hours=24)
    tasks = (
        db.query(Task)
        .filter(Task.user_id == user.id)
        .order_by(Task.deadline.asc(), Task.id.desc())
        .all()
    )
    events = (
        db.query(CalendarEvent)
        .filter(CalendarEvent.user_id == user.id)
        .order_by(CalendarEvent.start_time.asc())
        .all()
    )
    active_tasks = [task for task in tasks if task.status != "completed"]
    overdue_tasks = [
        task for task in active_tasks
        if task.deadline and as_utc(task.deadline) < now
    ]
    due_soon_tasks = [
        task for task in active_tasks
        if task.deadline and now <= as_utc(task.deadline) <= next_day
    ]
    priority_briefing = build_daily_briefing(tasks, events)
    overdue = [
        {
            "id": task.id,
            "title": task.title,
            "deadline": task.deadline,
            "hours_overdue": round((now - as_utc(task.deadline)).total_seconds() / 3600, 1)
            if task.deadline else None,
        }
        for task in overdue_tasks
    ]
    due_soon = [
        {
            "id": task.id,
            "title": task.title,
            "deadline": task.deadline,
            "hours_until_deadline": round((as_utc(task.deadline) - now).total_seconds() / 3600, 1)
            if task.deadline else None,
        }
        for task in due_soon_tasks
    ]
    digest_payload = {
        "overdue_tasks": overdue,
        "due_soon": due_soon,
        "missed_habits": [],
        "priority_briefing": priority_briefing,
    }
    if not overdue and not due_soon:
        digest_payload["agent_message"] = "You're all caught up!"
    else:
        parts = []
        if overdue:
            parts.append(f"{len(overdue)} overdue task(s)")
        if due_soon:
            parts.append(f"{len(due_soon)} task(s) due in 24h")
        digest_payload["agent_message"] = f"You have {' and '.join(parts)}. Want me to plan your next few hours?"
    digest_payload["agent_message"] = await generate_digest_message(digest_payload)
    return digest_payload


@app.post("/agent/create-tasks")
def create_agent_tasks(
    tasks_payload: list[TaskCreate],
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
):
    """Batch create tasks suggested by agent"""
    created_tasks = []
    for task_data in tasks_payload[:10]:  # Max 10 tasks at once
        task = Task(user_id=user.id, **task_data.model_dump())
        db.add(task)
        created_tasks.append(task)

    db.commit()
    for task in created_tasks:
        db.refresh(task)
        schedule_firebase_sync(firebase_sync_task, task)

    return created_tasks


if STATIC_DIR.exists():
    assets_dir = STATIC_DIR / "assets"
    if assets_dir.exists():
        app.mount("/assets", StaticFiles(directory=str(assets_dir)), name="assets")

    def frontend_file_response(full_path: str):
        index_path = STATIC_DIR / "index.html"
        requested_path = (STATIC_DIR / full_path).resolve()
        try:
            requested_path.relative_to(STATIC_DIR.resolve())
        except ValueError:
            requested_path = index_path
        if requested_path.is_file():
            return FileResponse(requested_path)
        return FileResponse(index_path)

    @app.get("/", include_in_schema=False)
    def serve_frontend_root():
        return FileResponse(STATIC_DIR / "index.html")

    @app.head("/", include_in_schema=False)
    def serve_frontend_root_head():
        return FileResponse(STATIC_DIR / "index.html")

    @app.get("/{full_path:path}", include_in_schema=False)
    def serve_frontend(full_path: str):
        return frontend_file_response(full_path)

    @app.head("/{full_path:path}", include_in_schema=False)
    def serve_frontend_head(full_path: str):
        return frontend_file_response(full_path)
