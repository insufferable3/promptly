from datetime import datetime, timezone
from typing import Any


def _as_utc(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def task_priority_score(task: Any, now: datetime | None = None) -> dict:
    now = _as_utc(now) if now else datetime.now(timezone.utc)
    deadline = getattr(task, "deadline", None)
    if deadline:
        deadline = _as_utc(deadline)
    estimated_time = getattr(task, "estimated_time", 45) or 45
    priority = (getattr(task, "priority", "medium") or "medium").lower()
    category = (getattr(task, "category", "work") or "work").lower()

    hours_until_deadline = 96
    overdue = False
    if deadline:
        hours_until_deadline = (deadline - now).total_seconds() / 3600
        overdue = hours_until_deadline < 0

    deadline_score = 40 if overdue else max(0, 34 - max(hours_until_deadline, 0) / 3)
    effort_score = min(18, estimated_time / 8)
    priority_score = {"high": 24, "medium": 14, "low": 6}.get(priority, 12)
    category_score = {"study": 12, "work": 10, "personal": 6}.get(category, 8)
    score = round(min(100, deadline_score + effort_score + priority_score + category_score))

    if overdue:
        explanation = "Overdue. Build a recovery plan and reschedule immediately."
    elif deadline and hours_until_deadline <= 24:
        explanation = "Deadline is close. Protect a focus block before lower-pressure work."
    elif estimated_time >= 90:
        explanation = "Large task. Break it into subtasks and schedule multiple blocks."
    else:
        explanation = "Good candidate for a short focus session."

    return {
        "score": score,
        "explanation": explanation,
        "overdue": overdue,
        "hours_until_deadline": round(hours_until_deadline, 1),
    }


def build_daily_briefing(tasks: list[Any], events: list[Any]) -> dict:
    active_tasks = [task for task in tasks if getattr(task, "status", "todo") != "completed"]
    prioritized = sorted(
        [
            {
                "id": task.id,
                "title": task.title,
                "category": task.category,
                "priority": task.priority,
                "estimated_time": task.estimated_time,
                "deadline": task.deadline,
                "priority_meta": task_priority_score(task),
            }
            for task in active_tasks
        ],
        key=lambda item: item["priority_meta"]["score"],
        reverse=True,
    )
    workload = sum(task.estimated_time or 45 for task in active_tasks)

    return {
        "top_tasks": prioritized[:3],
        "urgent_deadlines": [
            task for task in prioritized
            if task["priority_meta"]["score"] >= 65 or task["priority_meta"]["overdue"]
        ][:3],
        "calendar_conflicts": [],
        "suggested_focus_sessions": [
            {
                "task_id": task["id"],
                "title": task["title"],
                "duration_minutes": 90 if task["priority_meta"]["score"] >= 80 else 50,
            }
            for task in prioritized[:3]
        ],
        "estimated_workload_minutes": workload,
        "calendar_event_count": len(events),
    }
