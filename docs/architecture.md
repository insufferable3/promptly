# Promptly Architecture

Promptly is a proactive AI accountability assistant. The product should not behave like a generic chatbot or a passive todo list. Its job is to convert messy user intent into plans, scheduled focus blocks, accountability nudges, recovery plans, habits, and measurable progress.

## MVP Architecture

```text
Electron desktop shell
  -> React widget UI
  -> Productivity engine
  -> FastAPI backend
  -> Mistral agent layer
  -> Google Calendar
  -> PostgreSQL / Supabase
```

The hackathon MVP should keep the product usable even when one dependency is down. React computes a local priority briefing, FastAPI handles durable data and calendar calls, and Mistral improves language understanding when available.

## Core Services

`ProductivityEngine`
- Scores task priority from deadline proximity, effort, category, manual priority, and overdue state.
- Returns score, explanation, and recommended order.
- Generates daily briefing and focus session suggestions.
- Creates default subtasks for large assignments, exams, and projects.
- Computes analytics and habit consistency.

`AgentService`
- Uses the Promptly productivity-coach system prompt.
- Refuses unrelated general knowledge queries.
- Extracts structured actions: create task, update task, create reminder, schedule focus, answer schedule question.
- Calls the scheduler instead of inventing calendar slots.

`CalendarService`
- Reads Google Calendar.
- Finds available slots inside user work hours.
- Avoids meetings, classes, blocked focus sessions, and sleep time.
- Creates optional Google Calendar focus blocks.

`AccountabilityService`
- Checks incomplete tasks before and after scheduled focus blocks.
- Asks why a task was missed.
- Reschedules based on deadline pressure and remaining effort.
- Updates streaks, misses, and completion rate.

`MemoryService`
- Stores work hours, sleep schedule, preferred focus duration, recurring goals, missed-task patterns, and productive hours.
- Feeds that context into the agent and scheduler.

## Database Schema

Recommended Supabase/PostgreSQL tables:

```sql
users (
  id uuid primary key,
  name text,
  email text unique,
  preferences jsonb default '{}',
  work_hours text default '09:00-17:00',
  sleep_time text default '23:00',
  created_at timestamptz default now()
);

tasks (
  id uuid primary key,
  user_id uuid references users(id),
  title text not null,
  description text default '',
  category text check (category in ('Study', 'Work', 'Personal')),
  priority text check (priority in ('low', 'medium', 'high')),
  importance int default 3,
  estimated_time int default 45,
  deadline timestamptz,
  status text default 'todo',
  priority_score int default 0,
  priority_explanation text,
  created_at timestamptz default now(),
  completed_at timestamptz
);

subtasks (
  id uuid primary key,
  task_id uuid references tasks(id) on delete cascade,
  title text not null,
  status text default 'todo',
  sort_order int default 0
);

calendar_events (
  id uuid primary key,
  user_id uuid references users(id),
  google_event_id text,
  title text,
  start_time timestamptz,
  end_time timestamptz,
  type text default 'calendar'
);

focus_sessions (
  id uuid primary key,
  user_id uuid references users(id),
  task_id uuid references tasks(id),
  start_time timestamptz,
  duration_minutes int,
  status text default 'planned'
);

habits (
  id uuid primary key,
  user_id uuid references users(id),
  title text,
  cadence text default 'daily',
  streak int default 0
);

habit_logs (
  id uuid primary key,
  habit_id uuid references habits(id) on delete cascade,
  log_date date,
  completed boolean default false
);

accountability_events (
  id uuid primary key,
  user_id uuid references users(id),
  task_id uuid references tasks(id),
  event_type text,
  note text,
  created_at timestamptz default now()
);
```

## API Routes

MVP routes:
- `POST /agent/run` parses intent and returns structured tasks, reminders, focus blocks, and coach response.
- `GET /tasks` lists tasks.
- `POST /tasks` creates a task.
- `PATCH /tasks/{id}` updates category, deadline, priority, or status.
- `GET /tasks/prioritize` returns scored and ordered tasks.
- `POST /tasks/{id}/subtasks` creates generated subtasks.
- `PATCH /subtasks/{id}` toggles completion.
- `GET /briefing/today` returns top 3, urgent deadlines, conflicts, workload, and focus suggestions.
- `POST /focus-sessions` schedules a focus block.
- `PATCH /focus-sessions/{id}` starts, completes, or cancels a session.
- `GET /habits` lists habits.
- `POST /habits/{id}/log` marks today done.
- `GET /analytics/productivity` returns completion rate, missed tasks, productive hour, and habit consistency.
- `GET /google-calendar/events` reads Google Calendar.
- `POST /google-calendar/events` creates a focus event.

## React Component Structure

```text
src/
  main.jsx
  lib/
    agentClient.js
    productivityEngine.js
  components/
    widget/
      MiniMode.jsx
      ExpandedMode.jsx
    dashboard/
      BriefingPanel.jsx
      AnalyticsPanel.jsx
      FocusPanel.jsx
      HabitPanel.jsx
    tasks/
      TaskRow.jsx
      CategoryBoard.jsx
      CompletedBoard.jsx
      TaskBreakdown.jsx
    calendar/
      CalendarBoard.jsx
      DayCalendarView.jsx
```

The current MVP keeps these components in `src/main.jsx` for speed. Split them into folders once the hackathon demo stabilizes.

## AI Prompt Contract

Promptly AI must:
- Act as a productivity coach and accountability assistant.
- Use tasks, deadlines, habits, calendar events, and productivity stats.
- Return concise, actionable plans.
- Prioritize and schedule instead of chatting generally.
- Refuse unrelated questions by redirecting to productivity help.

Structured output keys:

```json
{
  "title": "Task scheduled",
  "reasoning": "Why this action matters",
  "content": "Concise assistant response",
  "followUp": "Next action",
  "suggested_tasks": [],
  "schedule_blocks": [],
  "suggested_reminders": [],
  "agent_steps": []
}
```

## Implementation Roadmap

Phase 1, hackathon MVP:
- Local priority engine.
- Daily briefing dashboard.
- Task completion and completed lane.
- Subtask breakdown for large tasks.
- Habit tracker.
- Focus session suggestions.
- Google Calendar read and manual focus event creation.
- Mistral productivity-coach prompt.

Phase 2, reliable assistant:
- Persist task status, subtasks, habits, and focus sessions in Supabase.
- Add `/briefing/today` backend route.
- Add calendar free-slot search.
- Add missed-task recovery flow.
- Add notification worker for accountability checks.

Phase 3, SaaS:
- Multi-user auth.
- Team/workspace mode.
- Billing.
- Background desktop updater.
- Cross-device sync.
- Long-term memory and productivity pattern learning.
