# Promptly

Promptly is an AI productivity companion with a floating desktop widget, a React/Vite dashboard, and a FastAPI backend. It helps users capture tasks, plan focus sessions, manage reminders, and connect with Google Calendar.

For deployment, the Electron desktop app is **not** deployed to Google Cloud. Google Cloud Run hosts the FastAPI backend and the built React web app. Electron remains the local desktop shell.

---

## Features

- AI productivity agent for task creation, reminders, scheduling, and daily planning
- Floating desktop widget with expanded mode, mini mode, hide/unhide behavior, and draggable UI
- React + Vite frontend
- FastAPI backend
- Mistral API support with fallback behavior
- Google Calendar OAuth integration
- Task, reminder, and calendar event APIs
- Optional n8n webhook integration
- Docker setup for Google Cloud Run deployment

---

## Project Structure

Your repo should look like this before running or deploying:

```txt
promptly/
  Dockerfile
  package.json
  package-lock.json
  index.html
  vite.config.js
  promptly-widget.jsx

  src/
    main.jsx
    styles.css
    lib/
      agentClient.js
      productivityEngine.js

  backend/
    main.py
    database.py
    models.py
    productivity.py
    schemas.py
    firebase_sync.py
    requirements.txt
    google_credentials.json        # local only, do not commit
    .env                           # local only, do not commit
```

If your files currently have downloaded/uploaded names, rename them like this:

```txt
main(5).py              -> backend/main.py
models(5).py            -> backend/models.py
productivity(3).py      -> backend/productivity.py
schemas(5).py           -> backend/schemas.py
database.py             -> backend/database.py
requirements(5).txt     -> backend/requirements.txt
main(2).jsx             -> src/main.jsx
styles(1).css           -> src/styles.css
vite.config(1).js       -> vite.config.js
README(1).md            -> README.md
promptly-widget(2).jsx  -> promptly-widget.jsx
```

Make sure these files also exist before Docker deploy:

```txt
package.json
package-lock.json
index.html
src/lib/agentClient.js
src/lib/productivityEngine.js
backend/firebase_sync.py
```

---

## Local Setup

### 1. Install frontend dependencies

```bash
npm install
```

### 2. Install backend dependencies

```bash
cd backend
python -m venv venv
source venv/bin/activate
pip install -r requirements.txt
cd ..
```

On Windows:

```bash
cd backend
python -m venv venv
venv\Scripts\activate
pip install -r requirements.txt
cd ..
```

---

## Environment Variables

Create `backend/.env`:

```env
APP_TIMEZONE=Asia/Kolkata

# Database
DATABASE_URL=sqlite:///./promptly.db

# Public URLs for local development
PUBLIC_BASE_URL=http://127.0.0.1:8000
FRONTEND_REDIRECT_URL=http://127.0.0.1:5173/
GOOGLE_REDIRECT_URI=http://127.0.0.1:8000/auth/google/callback

# Mistral
MISTRAL_API_KEY=your_mistral_api_key_here
MISTRAL_API_MODEL=mistral-small-latest
MISTRAL_API_TIMEOUT_SECONDS=8

# Google OAuth
GOOGLE_CREDENTIALS_PATH=google_credentials.json
GOOGLE_TOKEN_PATH=google_token.json

# Optional n8n webhook
N8N_WEBHOOK_SECRET=replace-with-a-long-random-value
```

For production, do not use SQLite for real user data. Use PostgreSQL and set `DATABASE_URL` to your hosted Postgres connection string.

Example:

```env
DATABASE_URL=postgresql+psycopg2://USER:PASSWORD@HOST:5432/DBNAME
```

---

## Google Calendar Setup

1. Go to Google Cloud Console.
2. Create an OAuth Client ID for a web application.
3. Add this local redirect URI:

```txt
http://127.0.0.1:8000/auth/google/callback
```

4. Download the OAuth client JSON.
5. Save it as:

```txt
backend/google_credentials.json
```

For deployed Cloud Run, also add your deployed redirect URI:

```txt
https://YOUR-CLOUD-RUN-URL/auth/google/callback
```

Your backend must use the same value in `GOOGLE_REDIRECT_URI`.

---

## Run Locally

### Start backend

```bash
cd backend
source venv/bin/activate
uvicorn main:app --host 0.0.0.0 --port 8000 --reload
```

Check:

```txt
http://127.0.0.1:8000/health
http://127.0.0.1:8000/agent/status
```

### Start frontend

In another terminal:

```bash
npm run dev
```

Open:

```txt
http://127.0.0.1:5173
```

### Run Electron desktop app

```bash
npm run desktop
```

---

## Build Frontend

```bash
npm run build
```

The production frontend build should be created in:

```txt
dist/
```

The backend serves this folder using `STATIC_DIR`.

---

## Docker Build Locally

From the project root:

```bash
docker build -t promptly .
docker run --rm -p 8080:8080 \
  -e PORT=8080 \
  -e APP_TIMEZONE=Asia/Kolkata \
  -e MISTRAL_API_KEY=your_mistral_api_key_here \
  promptly
```

Open:

```txt
http://127.0.0.1:8080
http://127.0.0.1:8080/health
```

---

## Deploy to Google Cloud Run

### 1. Login and select project

```bash
gcloud init
gcloud config set project YOUR_PROJECT_ID
```

### 2. Enable required services

```bash
gcloud services enable \
  run.googleapis.com \
  cloudbuild.googleapis.com \
  artifactregistry.googleapis.com \
  secretmanager.googleapis.com \
  sqladmin.googleapis.com
```

### 3. Create secrets

```bash
printf '%s' "YOUR_MISTRAL_API_KEY" | \
  gcloud secrets create mistral-api-key --data-file=-
```

For Google OAuth credentials:

```bash
gcloud secrets create google-oauth-json \
  --data-file=backend/google_credentials.json
```

### 4. First deploy

```bash
gcloud run deploy promptly \
  --source . \
  --region asia-south1 \
  --allow-unauthenticated \
  --memory 1Gi \
  --cpu 1 \
  --min-instances 0 \
  --max-instances 1 \
  --set-env-vars APP_TIMEZONE=Asia/Kolkata \
  --set-env-vars MISTRAL_API_MODEL=mistral-small-latest
```

### 5. Get service URL

```bash
gcloud run services describe promptly \
  --region asia-south1 \
  --format='value(status.url)'
```

Assume the output is:

```txt
https://promptly-xxxxx-uc.a.run.app
```

### 6. Update production environment variables

```bash
gcloud run services update promptly \
  --region asia-south1 \
  --update-env-vars PUBLIC_BASE_URL=https://promptly-xxxxx-uc.a.run.app \
  --update-env-vars FRONTEND_REDIRECT_URL=https://promptly-xxxxx-uc.a.run.app/ \
  --update-env-vars GOOGLE_REDIRECT_URI=https://promptly-xxxxx-uc.a.run.app/auth/google/callback
```

### 7. Attach secrets

```bash
gcloud run services update promptly \
  --region asia-south1 \
  --update-secrets MISTRAL_API_KEY=mistral-api-key:latest,GOOGLE_CREDENTIALS_JSON=google-oauth-json:latest
```

### 8. Add Google OAuth redirect URI

In Google Cloud Console, add this authorized redirect URI to your OAuth Client:

```txt
https://promptly-xxxxx-uc.a.run.app/auth/google/callback
```

Redeploy or update the service after changing environment variables.

---

## Production Database

For quick demo, SQLite may work temporarily, but it is not recommended on Cloud Run.

Use one of these instead:

- Cloud SQL PostgreSQL
- Supabase PostgreSQL
- Neon PostgreSQL
- Railway PostgreSQL

Then set:

```bash
gcloud run services update promptly \
  --region asia-south1 \
  --update-env-vars DATABASE_URL='postgresql+psycopg2://USER:PASSWORD@HOST:5432/DBNAME'
```

---

## Important Deployment Notes

- Cloud Run deploys the backend and web app, not the Electron desktop shell.
- Electron should call the deployed backend using `VITE_API_BASE_URL` or your agent client config.
- Do not commit `.env`, `google_credentials.json`, `google_token.json`, or database files.
- Do not rely on `/tmp/google_token.json` for long-term OAuth storage in production.
- For multi-user production, store Google tokens per user in the database.
- Make sure your Google OAuth redirect URI exactly matches the deployed backend URL.

---

## Health Check Endpoints

Useful endpoints after backend starts:

```txt
GET /health
GET /agent/status
GET /desktop-widget/status
POST /desktop-widget/hidden
POST /desktop-widget/unhide
GET /auth/google/login-url
GET /auth/google/callback
POST /webhooks/n8n
```

---

## n8n Webhook

Set this in your backend environment:

```env
N8N_WEBHOOK_SECRET=replace-with-a-long-random-value
```

Send planner output to:

```txt
POST /webhooks/n8n
```

Include the secret header:

```txt
X-N8N-Webhook-Secret: replace-with-a-long-random-value
```

Example payload:

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

---

## Build Desktop Installers

```bash
npm run dist
```

Expected installer targets depend on your Electron Builder config. Common targets:

- macOS: `.dmg`, `.zip`
- Windows: `.exe` installer

---

## Troubleshooting

### Docker build fails at `npm ci`

Make sure `package-lock.json` exists. If it does not, run:

```bash
npm install
```

Then commit the generated `package-lock.json`.

### Docker build cannot find `src`

Make sure the frontend files are inside `src/`, especially:

```txt
src/main.jsx
src/styles.css
src/lib/agentClient.js
src/lib/productivityEngine.js
```

### Backend fails with `ModuleNotFoundError: firebase_sync`

Make sure this file exists:

```txt
backend/firebase_sync.py
```

If Firebase is optional, create a safe fallback module or remove the imports from `backend/main.py`.

### Google login says `redirect_uri_mismatch`

Your `GOOGLE_REDIRECT_URI` must exactly match the authorized redirect URI in Google Cloud Console.

For local:

```txt
http://127.0.0.1:8000/auth/google/callback
```

For deployed:

```txt
https://YOUR-CLOUD-RUN-URL/auth/google/callback
```

### Mistral not working

Check:

```txt
GET /agent/status
```

Also verify:

```env
MISTRAL_API_KEY=...
MISTRAL_API_MODEL=mistral-small-latest
```

### App works locally but not on Cloud Run

Check these first:

- Cloud Run logs
- `PORT` is being used correctly by Uvicorn
- `PUBLIC_BASE_URL` is set to your Cloud Run URL
- `GOOGLE_REDIRECT_URI` is set to your Cloud Run callback URL
- `DATABASE_URL` points to a real production database
- Secrets are attached correctly

---

## Recommended Today Scope

For a same-day deployment, ship this:

- React web dashboard
- FastAPI backend
- Mistral API integration
- Google login/calendar connect
- Task/reminder/calendar APIs
- Widget hide/mini behavior
- Cloud Run deployment

Do this later:

- Durable Google token storage in database
- Proper multi-user OAuth token model
- Full Electron auto-updater
- Production analytics
- Payment/subscription logic
- Full Supabase/Firebase sync hardening

