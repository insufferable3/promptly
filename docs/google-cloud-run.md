# Deploy to Google Cloud Run

This deploys the React web app and FastAPI backend as one Cloud Run service.

## Expected repo layout

Before deploying, make sure uploaded/downloaded files have been renamed into the normal project layout:

```text
Dockerfile
package.json
package-lock.json
index.html
vite.config.js
src/
  main.jsx
backend/
  main.py
  database.py
  models.py
  schemas.py
  firebase_sync.py
  requirements.txt
```

Files named like `main(5).py`, `main(2).jsx`, or `vite.config(1).js` will not be used by the Dockerfile.

## 1. Pick project settings

```bash
export PROJECT_ID="your-gcp-project-id"
export REGION="asia-south1"
export SERVICE="promptly"
gcloud config set project "$PROJECT_ID"
gcloud services enable run.googleapis.com cloudbuild.googleapis.com secretmanager.googleapis.com
```

## 2. Create a durable database

Cloud Run filesystem is ephemeral, so do not use the SQLite fallback for a real deployment. Create/use Postgres, then store its SQLAlchemy URL:

```bash
printf "%s" "postgresql://USER:PASSWORD@HOST:5432/DB_NAME" \
  | gcloud secrets create promptly-database-url --data-file=-
```

For Cloud SQL, use the connection method you prefer, but still pass the final SQLAlchemy URL as `DATABASE_URL`.

## 3. Create secrets

Do not bake local credential JSON files into the image.

```bash
gcloud secrets create promptly-google-oauth --data-file=backend/google_credentials.json
gcloud secrets create promptly-firebase-service-account --data-file=backend/firebase_service_account.json
```

Optional Mistral key:

```bash
printf "%s" "$MISTRAL_API_KEY" | gcloud secrets create promptly-mistral-api-key --data-file=-
```

## 4. First deploy

```bash
gcloud run deploy "$SERVICE" \
  --source . \
  --region "$REGION" \
  --allow-unauthenticated \
  --set-env-vars "APP_TIMEZONE=Asia/Kolkata" \
  --set-secrets "DATABASE_URL=promptly-database-url:latest,GOOGLE_CREDENTIALS_JSON=promptly-google-oauth:latest,FIREBASE_SERVICE_ACCOUNT_JSON=promptly-firebase-service-account:latest"
```

Copy the service URL from the deploy output.

## 5. Configure Google OAuth

In Google Cloud Console, add this authorized redirect URI to the OAuth web client:

```text
https://YOUR-CLOUD-RUN-URL/auth/google/callback
```

Then update the service with the public URL:

```bash
export PUBLIC_BASE_URL="https://YOUR-CLOUD-RUN-URL"
gcloud run services update "$SERVICE" \
  --region "$REGION" \
  --set-env-vars "PUBLIC_BASE_URL=$PUBLIC_BASE_URL,APP_TIMEZONE=Asia/Kolkata" \
  --set-secrets "DATABASE_URL=promptly-database-url:latest,GOOGLE_CREDENTIALS_JSON=promptly-google-oauth:latest,FIREBASE_SERVICE_ACCOUNT_JSON=promptly-firebase-service-account:latest"
```

## Notes

- Public deployments refuse to boot with SQLite when `PUBLIC_BASE_URL` is set unless `ALLOW_SQLITE_IN_PRODUCTION=true`.
- Firebase sync is configured through `FIREBASE_SERVICE_ACCOUNT_JSON`.
- Google OAuth login is configured through `GOOGLE_CREDENTIALS_JSON`.
- Google Calendar tokens are stored per user in the SQL database, not in `/tmp`.
