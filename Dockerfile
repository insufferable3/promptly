# ---------- Frontend build ----------
FROM node:20-slim AS frontend

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY index.html vite.config.js ./
COPY src ./src

RUN npm run build


# ---------- Backend runtime ----------
FROM python:3.11-slim

WORKDIR /app/backend

ENV PYTHONUNBUFFERED=1
ENV STATIC_DIR=/app/dist
ENV PORT=10000

COPY backend/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

COPY backend/ ./
COPY --from=frontend /app/dist /app/dist

CMD uvicorn main:app --host 0.0.0.0 --port ${PORT:-10000}
