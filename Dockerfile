FROM node:22-bookworm-slim AS frontend

WORKDIR /app
COPY package*.json ./
RUN npm ci

COPY index.html vite.config.js promptly-widget.jsx ./
COPY src ./src
RUN npm run build

FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    STATIC_DIR=/app/dist

WORKDIR /app
RUN apt-get update \
    && apt-get install -y --no-install-recommends gcc libpq-dev \
    && rm -rf /var/lib/apt/lists/*

COPY backend/requirements.txt ./backend/requirements.txt
RUN pip install --no-cache-dir -r backend/requirements.txt

COPY backend ./backend
COPY --from=frontend /app/dist ./dist

WORKDIR /app/backend
CMD exec uvicorn main:app --host 0.0.0.0 --port ${PORT:-8080}
