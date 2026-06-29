# Promptly

> **An AI-powered productivity companion that helps users capture tasks, manage reminders, plan focus sessions, and organize their schedule through a web dashboard and a floating desktop widget.**

Promptly is a full-stack AI productivity application built with **React**, **FastAPI**, **Electron**, and **Mistral AI**. It enables users to manage tasks, reminders, and calendar events using natural language while integrating seamlessly with Google Calendar.

The project combines a modern web application with a desktop companion, providing quick access to productivity tools without disrupting the user's workflow.

---

## Live Demo

**Application:** https://promptly-f8s0.onrender.com

**Project Documentation:** https://docs.google.com/document/d/1AzLR26IRFiP_tZ-B7m_W_oA8JYk2v00bP2Xbe1aUf6Y/edit?usp=sharing

---

## Features

### AI Productivity Assistant

* Create tasks using natural language
* Generate reminders and daily schedules
* Plan focus sessions
* AI-assisted productivity workflows powered by Mistral AI

### Desktop Widget

* Floating desktop companion
* Expanded and compact modes
* Draggable interface
* Hide and restore functionality
* Quick access to tasks and reminders

### Web Dashboard

* Built with React and Vite
* Responsive user interface
* Task management
* Reminder management
* Calendar overview

### Google Calendar Integration

* Google OAuth 2.0 authentication
* Calendar synchronization
* Event creation and management

### Backend Services

* FastAPI REST API
* SQLAlchemy ORM
* Modular backend architecture
* Optional n8n webhook integration
* Docker support
* Production deployment on Render

---

## Tech Stack

| Layer          | Technologies                                        |
| -------------- | --------------------------------------------------- |
| Frontend       | React, Vite, JavaScript                             |
| Desktop        | Electron                                            |
| Backend        | FastAPI, Python                                     |
| Database       | SQLite (Development), PostgreSQL (Production Ready) |
| AI             | Mistral AI                                          |
| Authentication | Google OAuth 2.0                                    |
| APIs           | Google Calendar API                                 |
| Deployment     | Docker, Render                                      |

---

## Architecture

```text
                 Electron Desktop Widget
                          │
                          │
                React + Vite Web Dashboard
                          │
                    REST API Requests
                          │
                    FastAPI Backend
                          │
        ┌─────────────────┼─────────────────┐
        │                 │                 │
   Mistral AI      Google Calendar API    Database
```

---

## Project Structure

```text
promptly/
│
├── src/
│   ├── components/
│   ├── lib/
│   ├── main.jsx
│   └── styles.css
│
├── backend/
│   ├── main.py
│   ├── models.py
│   ├── schemas.py
│   ├── productivity.py
│   ├── database.py
│   ├── firebase_sync.py
│   └── requirements.txt
│
├── promptly-widget.jsx
├── Dockerfile
├── package.json
└── README.md
```

---

## Local Installation

Clone the repository:

```bash
git clone https://github.com/insufferable3/promptly.git
cd promptly
```

Install frontend dependencies:

```bash
npm install
```

Install backend dependencies:

```bash
cd backend

python -m venv venv

source venv/bin/activate
# Windows:
# venv\Scripts\activate

pip install -r requirements.txt

cd ..
```

Create a `backend/.env` file and configure:

* Mistral API credentials
* Google OAuth credentials
* Database connection
* Application URLs

---

## Running the Application

Start the backend:

```bash
cd backend

uvicorn main:app --host 0.0.0.0 --port 8000 --reload
```

Start the frontend:

```bash
npm run dev
```

Launch the Electron desktop application:

```bash
npm run desktop
```

---

## Deployment

Promptly is containerized using Docker and deployed on Render.

The production deployment includes:

* FastAPI backend
* React web application
* Google OAuth authentication
* Google Calendar integration
* Mistral AI integration

The Electron desktop application is intended to run locally and communicates with the deployed backend.

---

## API Endpoints

| Method | Endpoint                 | Description          |
| ------ | ------------------------ | -------------------- |
| GET    | `/health`                | Service health check |
| GET    | `/agent/status`          | AI agent status      |
| GET    | `/desktop-widget/status` | Widget status        |
| POST   | `/desktop-widget/hidden` | Hide widget          |
| POST   | `/desktop-widget/unhide` | Restore widget       |
| GET    | `/auth/google/login-url` | Google OAuth login   |
| GET    | `/auth/google/callback`  | OAuth callback       |
| POST   | `/webhooks/n8n`          | n8n webhook endpoint |

---

## Future Improvements

* Persistent multi-user authentication
* PostgreSQL production database
* Long-term user preference storage
* Desktop auto-updater
* Advanced AI planning workflows
* Voice interaction support
* Analytics dashboard

---

## License

This project is intended for educational, research, and portfolio purposes.
