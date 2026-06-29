# Promptly Desktop

Promptly is an AI productivity companion that lives on the user's desktop as a floating widget, not a traditional website.

## Architecture

```text
Electron shell
  -> React + Tailwind UI
  -> AI agent client
  -> FastAPI agent backend
  -> Google Calendar
  -> Supabase database layer
```

## Desktop Behavior

- Always-on-top floating widget
- Mini circular orb mode
- Expanded productivity dashboard
- Draggable frameless window
- Resizable expanded window
- System tray controls
- Launches automatically on system startup
- Mocks AI/calendar data when backend is unavailable

## Run Desktop App

```bash
npm install
npm run desktop
```

Run backend separately for real AI and Google Calendar:

```bash
npm run backend
```

The backend loads `backend/.env` automatically.
Restart this command after backend code changes.

Optional OAuth redirect after Google authorization:

```bash
FRONTEND_REDIRECT_URL=http://localhost:5173/
```

AI priority order:
- `MISTRAL_API_KEY` cloud API, fastest/recommended
- local Ollama Mistral
- deterministic mock agent fallback

Optional model config:

```bash
export MISTRAL_API_MODEL="mistral-small-latest"
export MISTRAL_API_TIMEOUT_SECONDS=8
```

## n8n Webhook

Set a private webhook secret in `backend/.env`:

```bash
N8N_WEBHOOK_SECRET=replace-with-a-long-random-value
```

Send validated planner output to `POST /webhooks/n8n` with the same value in the
`X-N8N-Webhook-Secret` header. The payload shape is:

```json
{
  "user_id": 1,
  "plan": {
    "intent": "create_task",
    "confidence": 0.95,
    "task": {
      "title": "Submit DBMS assignment",
      "category": "study",
      "priority": "high",
      "deadline": "2026-06-26T20:00:00+05:30",
      "estimated_minutes": 60
    },
    "calendar_event": {
      "should_create": false,
      "start_time": null,
      "end_time": null
    },
    "needs_confirmation": false,
    "reply": "Task created."
  }
}
```

## Build Installers

```bash
npm run dist
```

Configured targets:
- macOS: `dmg`, `zip`
- Windows: `nsis`

## Google Calendar

Place OAuth credentials here:

```text
backend/google_credentials.json
```

Then run the backend and connect from the Calendar area. Tokens are ignored by git.

## Supabase

Set these in your environment when ready:

```bash
VITE_SUPABASE_URL=...
VITE_SUPABASE_ANON_KEY=...
```

The UI works without Supabase using local mock data.
