import logging
import json
import os
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

BACKEND_DIR = Path(__file__).resolve().parent
DEFAULT_SERVICE_ACCOUNT = BACKEND_DIR / "firebase_service_account.json"
FIREBASE_SERVICE_ACCOUNT = Path(
    os.getenv("FIREBASE_SERVICE_ACCOUNT", str(DEFAULT_SERVICE_ACCOUNT))
)
if not FIREBASE_SERVICE_ACCOUNT.is_absolute():
    FIREBASE_SERVICE_ACCOUNT = BACKEND_DIR / FIREBASE_SERVICE_ACCOUNT
FIREBASE_SERVICE_ACCOUNT_JSON = os.getenv("FIREBASE_SERVICE_ACCOUNT_JSON", "").strip()

_executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="firebase-sync")
_app = None
_db = None
_last_error: str | None = None


def _get_firestore():
    global _app, _db, _last_error
    if _db is not None:
        return _db
    if not FIREBASE_SERVICE_ACCOUNT_JSON and not FIREBASE_SERVICE_ACCOUNT.exists():
        _last_error = f"Firebase service account not found at {FIREBASE_SERVICE_ACCOUNT}"
        return None
    try:
        import firebase_admin
        from firebase_admin import credentials, firestore

        if not firebase_admin._apps:
            credential = credentials.Certificate(
                json.loads(FIREBASE_SERVICE_ACCOUNT_JSON)
                if FIREBASE_SERVICE_ACCOUNT_JSON
                else str(FIREBASE_SERVICE_ACCOUNT)
            )
            _app = firebase_admin.initialize_app(credential)
        else:
            _app = firebase_admin.get_app()
        _db = firestore.client()
        _last_error = None
        return _db
    except Exception as exc:
        _last_error = f"{type(exc).__name__}: {exc}"
        logger.warning("Firebase initialization failed: %s", _last_error)
        return None


def firebase_status() -> dict[str, Any]:
    db = _get_firestore()
    return {
        "configured": bool(FIREBASE_SERVICE_ACCOUNT_JSON) or FIREBASE_SERVICE_ACCOUNT.exists(),
        "ready": db is not None,
        "service_account_path": str(FIREBASE_SERVICE_ACCOUNT),
        "last_error": _last_error,
    }


def _clean(value: Any) -> Any:
    if isinstance(value, datetime):
        return value
    if isinstance(value, dict):
        return {key: _clean(item) for key, item in value.items()}
    if isinstance(value, list):
        return [_clean(item) for item in value]
    return value


def _field(record: Any, name: str, default: Any = None) -> Any:
    if isinstance(record, dict):
        return record.get(name, default)
    return getattr(record, name, default)


def _user_doc(user_id: int):
    db = _get_firestore()
    if db is None:
        return None
    return db.collection("users").document(str(user_id))


def _run_safely(operation, *args):
    try:
        operation(*args)
    except Exception as exc:
        global _last_error
        _last_error = f"{type(exc).__name__}: {exc}"
        logger.warning("Firebase sync failed: %s", _last_error)


def schedule_firebase_sync(operation, *args) -> None:
    if os.getenv("FIREBASE_SYNC_DISABLED", "").lower() in {"1", "true", "yes"}:
        return
    _executor.submit(_run_safely, operation, *args)


def sync_user(user: Any) -> None:
    user_id = _field(user, "id")
    doc = _user_doc(user_id)
    if doc is None:
        return
    doc.set(
        {
            "id": user_id,
            "name": _field(user, "name"),
            "email": _field(user, "email"),
            "preferences": _field(user, "preferences"),
            "work_hours": _field(user, "work_hours"),
            "sleep_time": _field(user, "sleep_time"),
            "updated_at": datetime.now(timezone.utc),
        },
        merge=True,
    )


def sync_task(task: Any) -> None:
    doc = _user_doc(_field(task, "user_id"))
    if doc is None:
        return
    doc.collection("tasks").document(str(_field(task, "id"))).set(
        _clean(
            {
                "id": _field(task, "id"),
                "user_id": _field(task, "user_id"),
                "title": _field(task, "title"),
                "description": _field(task, "description"),
                "deadline": _field(task, "deadline"),
                "category": _field(task, "category"),
                "priority": _field(task, "priority"),
                "estimated_time": _field(task, "estimated_time"),
                "status": _field(task, "status"),
                "updated_at": datetime.now(timezone.utc),
            }
        ),
        merge=True,
    )


def delete_task(user_id: int, task_id: int) -> None:
    doc = _user_doc(user_id)
    if doc is None:
        return
    doc.collection("tasks").document(str(task_id)).delete()


def sync_calendar_event(event: Any) -> None:
    doc = _user_doc(_field(event, "user_id"))
    if doc is None:
        return
    doc.collection("calendar_events").document(str(_field(event, "id"))).set(
        _clean(
            {
                "id": _field(event, "id"),
                "user_id": _field(event, "user_id"),
                "task_id": _field(event, "task_id"),
                "title": _field(event, "title"),
                "start_time": _field(event, "start_time"),
                "end_time": _field(event, "end_time"),
                "updated_at": datetime.now(timezone.utc),
            }
        ),
        merge=True,
    )


def delete_calendar_event(user_id: int, event_id: int) -> None:
    doc = _user_doc(user_id)
    if doc is None:
        return
    doc.collection("calendar_events").document(str(event_id)).delete()


def sync_reminder(reminder: Any) -> None:
    doc = _user_doc(_field(reminder, "user_id"))
    if doc is None:
        return
    doc.collection("reminders").document(str(_field(reminder, "id"))).set(
        _clean(
            {
                "id": _field(reminder, "id"),
                "user_id": _field(reminder, "user_id"),
                "title": _field(reminder, "title"),
                "due_at": _field(reminder, "due_at"),
                "status": _field(reminder, "status"),
                "updated_at": datetime.now(timezone.utc),
            }
        ),
        merge=True,
    )


def delete_reminder(user_id: int, reminder_id: int) -> None:
    doc = _user_doc(user_id)
    if doc is None:
        return
    doc.collection("reminders").document(str(reminder_id)).delete()
