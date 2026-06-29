from datetime import datetime, timezone
from typing import Any, Literal

from pydantic import BaseModel, EmailStr, Field, model_validator


class UserCreate(BaseModel):
    name: str
    email: EmailStr
    preferences: dict[str, Any] = Field(default_factory=dict)
    work_hours: str = "09:00-17:00"
    sleep_time: str = "23:00"


class UserOut(UserCreate):
    id: int

    class Config:
        from_attributes = True


class AuthResponse(BaseModel):
    token: str
    user: UserOut


class LoginRequest(BaseModel):
    email: EmailStr


class TaskCreate(BaseModel):
    title: str
    description: str = ""
    deadline: datetime | None = None
    category: str = "work"
    priority: str = "medium"
    estimated_time: int = 60
    status: str = "todo"


class TaskOut(TaskCreate):
    id: int
    user_id: int

    class Config:
        from_attributes = True


class TaskUpdate(BaseModel):
    title: str | None = None
    description: str | None = None
    deadline: datetime | None = None
    category: str | None = None
    priority: str | None = None
    estimated_time: int | None = Field(default=None, ge=1, le=1440)
    status: str | None = None


class CalendarEventCreate(BaseModel):
    title: str
    start_time: datetime
    end_time: datetime
    task_id: int | None = None


class CalendarEventOut(CalendarEventCreate):
    id: int
    user_id: int

    class Config:
        from_attributes = True


class ReminderCreate(BaseModel):
    title: str = Field(min_length=1, max_length=180)
    due_at: datetime | None = None
    status: str = "pending"


class ReminderOut(ReminderCreate):
    id: int
    user_id: int

    @model_validator(mode="after")
    def attach_utc_to_sqlite_datetime(self):
        if self.due_at and self.due_at.tzinfo is None:
            self.due_at = self.due_at.replace(tzinfo=timezone.utc)
        return self

    class Config:
        from_attributes = True


class GoogleCalendarEventCreate(BaseModel):
    title: str
    start_time: datetime
    end_time: datetime
    description: str = ""
    calendar_id: str = "primary"
    timezone: str = "Asia/Kolkata"


class GoogleCalendarEventOut(BaseModel):
    id: str
    title: str
    start_time: str | None = None
    end_time: str | None = None
    html_link: str | None = None


class AIRequest(BaseModel):
    message: str
    category: str = "work"


class AIResponse(BaseModel):
    title: str
    badge: str
    content: str
    followUp: str
    actions: list[str]


class AgentRequest(BaseModel):
    message: str
    category: str = "work"
    auto_create_tasks: bool = False
    history: list[dict[str, str]] = Field(default_factory=list)
    app_context: dict[str, Any] = Field(default_factory=dict)


class AgentPlannerTask(BaseModel):
    title: str = Field(min_length=1, max_length=180)
    category: Literal["study", "work", "personal"]
    priority: Literal["high", "medium", "low"] = "medium"
    deadline: datetime | None = None
    estimated_minutes: int = Field(default=45, ge=15, le=480)


class AgentPlannerCalendarEvent(BaseModel):
    should_create: bool = False
    start_time: datetime | None = None
    end_time: datetime | None = None

    @model_validator(mode="after")
    def validate_calendar_window(self):
        if self.should_create:
            if not self.start_time or not self.end_time:
                raise ValueError("Calendar start_time and end_time are required")
            if self.end_time <= self.start_time:
                raise ValueError("Calendar end_time must be after start_time")
        return self


class AgentPlannerDecision(BaseModel):
    intent: Literal[
        "chat",
        "create_task",
        "update_task",
        "delete_task",
        "productivity_advice",
    ]
    confidence: float = Field(ge=0, le=1)
    task: AgentPlannerTask | None = None
    calendar_event: AgentPlannerCalendarEvent | None = None
    delete_target: str | None = None
    needs_confirmation: bool = False
    reply: str = Field(min_length=1, max_length=1000)

    @model_validator(mode="after")
    def validate_intent_payload(self):
        if self.intent in {"create_task", "update_task"} and not self.task:
            raise ValueError("Task is required for create_task and update_task")
        return self


class N8nWebhookRequest(BaseModel):
    user_id: int = Field(ge=1)
    plan: AgentPlannerDecision


class AgentTaskSuggestion(BaseModel):
    title: str
    description: str = ""
    category: str = "work"
    priority: str = "medium"
    estimated_time: int = 45
    deadline: datetime | str | None = None


class AgentScheduleBlock(BaseModel):
    title: str
    start_hint: str
    duration_minutes: int = 45


class AgentAction(BaseModel):
    label: str
    tool: str


class AgentResponse(BaseModel):
    title: str
    badge: str = "Agent"
    model_source: str = "fallback"
    model_error: str | None = None
    intent: str = "chat"
    confidence: float = 0
    plan_validated: bool = False
    needs_confirmation: bool = False
    delete_target: str | None = None
    reasoning: str
    content: str
    followUp: str
    agent_steps: list[str] = Field(default_factory=list)
    actions: list[AgentAction]
    suggested_tasks: list[AgentTaskSuggestion]
    suggested_reminders: list[dict] = Field(default_factory=list)
    schedule_blocks: list[AgentScheduleBlock]
    created_tasks: list[TaskOut] = Field(default_factory=list)
    created_events: list[CalendarEventOut] = Field(default_factory=list)
    created_reminders: list[ReminderOut] = Field(default_factory=list)
