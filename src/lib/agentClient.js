const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || (
  typeof window !== 'undefined' && /^(localhost|127\.0\.0\.1)$/.test(window.location.hostname)
    ? 'http://127.0.0.1:8000'
    : ''
);
const STORAGE_VERSION = 'promptly-clean-v2';

function shouldUseDesktopSession() {
  if (typeof window === 'undefined') return false;
  return Boolean(window.promptlyDesktop)
    || /^(localhost|127\.0\.0\.1)$/.test(window.location.hostname);
}

function resetLegacyLocalState() {
  if (typeof window === 'undefined') return;
  if (window.localStorage.getItem('promptly-storage-version') === STORAGE_VERSION) return;
  [
    'promptly-tasks',
    'promptly-reminders',
    'promptly-events',
    'promptly-habits',
    'promptly-chat',
    'promptly-auth-token',
    'promptly-auth-user',
  ].forEach((key) => window.localStorage.removeItem(key));
  window.localStorage.setItem('promptly-storage-version', STORAGE_VERSION);
}

resetLegacyLocalState();

function getAuthHeaders() {
  const token = window.localStorage.getItem('promptly-auth-token');
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function storeAuthUser(user) {
  if (user) {
    window.localStorage.setItem('promptly-auth-user', JSON.stringify(user));
  }
}

export function getStoredAuthUser() {
  try {
    return JSON.parse(window.localStorage.getItem('promptly-auth-user') || 'null');
  } catch {
    return null;
  }
}

export function hasBackendSession() {
  return Boolean(window.localStorage.getItem('promptly-auth-token'));
}

export function consumeGoogleAuthRedirect() {
  const params = new URLSearchParams(window.location.search);
  const authError = params.get('auth_error');
  if (authError) {
    params.delete('auth_error');
    const nextQuery = params.toString();
    window.history.replaceState(
      {},
      document.title,
      `${window.location.pathname}${nextQuery ? `?${nextQuery}` : ''}${window.location.hash}`,
    );
    throw new Error(authError);
  }

  const token = params.get('auth_token');
  if (!token) return null;

  const user = {
    email: params.get('auth_email') || '',
    name: params.get('auth_name') || params.get('auth_email') || 'Google user',
    provider: 'google',
  };
  window.localStorage.setItem('promptly-auth-token', token);
  storeAuthUser(user);
  params.delete('auth_token');
  params.delete('auth_email');
  params.delete('auth_name');
  const nextQuery = params.toString();
  window.history.replaceState(
    {},
    document.title,
    `${window.location.pathname}${nextQuery ? `?${nextQuery}` : ''}${window.location.hash}`,
  );
  return user;
}

export async function ensureDesktopSession() {
  if (!shouldUseDesktopSession()) return false;
  if (hasBackendSession()) {
    const current = await fetch(`${API_BASE_URL}/tasks`, { headers: getAuthHeaders() });
    if (current.ok) {
      const storedUser = getStoredAuthUser();
      if (storedUser?.email !== 'desktop@promptly.app') return true;
    }
    if (current.status === 401) {
      window.localStorage.removeItem('promptly-auth-token');
      window.localStorage.removeItem('promptly-auth-user');
    }
  }
  const response = await fetch(`${API_BASE_URL}/auth/desktop`, { method: 'POST' });
  if (!response.ok) return false;
  const data = await response.json();
  if (!data.token) return false;
  window.localStorage.setItem('promptly-auth-token', data.token);
  storeAuthUser({ ...data.user, provider: 'desktop' });
  return true;
}

export async function getCurrentUser() {
  if (!hasBackendSession()) return null;
  const response = await fetch(`${API_BASE_URL}/auth/me`, { headers: getAuthHeaders() });
  if (!response.ok) return getStoredAuthUser();
  const user = await response.json();
  storeAuthUser(user);
  return user;
}

export async function getGoogleLoginUrl() {
  const response = await fetch(`${API_BASE_URL}/auth/google/login-url`);
  if (!response.ok) {
    let detail = 'Could not start Google login';
    try {
      const data = await response.json();
      detail = data.detail || detail;
    } catch {
      detail = await response.text() || detail;
    }
    throw new Error(detail);
  }
  const data = await response.json();
  return data.authorization_url;
}

export async function logoutBackendSession() {
  if (hasBackendSession()) {
    await fetch(`${API_BASE_URL}/auth/logout`, {
      method: 'POST',
      headers: getAuthHeaders(),
    }).catch(() => {});
  }
  window.localStorage.removeItem('promptly-auth-token');
  window.localStorage.removeItem('promptly-auth-user');
}

function readStoredList(key) {
  if (typeof window === 'undefined') return [];
  try {
    const value = JSON.parse(window.localStorage.getItem(key) || '[]');
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

function cleanStoredTasks() {
  const seen = new Set();
  return readStoredList('promptly-tasks')
    .filter((task) => {
      const title = String(task.title || '').trim().toLowerCase();
      return title
        && !/^i(?: am|'m)?\s+(?:thinking|considering)\s+(?:to|about)\b/.test(title);
    })
    .map((task) => {
      const title = String(task.title || '').trim();
      const malformedReminder = title.match(/^a\s+to\s+(.+)$/i);
      if (!malformedReminder) return task;
      const cleanTitle = malformedReminder[1].trim();
      return {
        ...task,
        title: cleanTitle.charAt(0).toUpperCase() + cleanTitle.slice(1),
      };
    })
    .filter((task) => {
      const key = String(task.title || '').trim().toLowerCase().replace(/\s+/g, ' ');
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function getLocalDateKey(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function cleanStoredHabits() {
  const today = getLocalDateKey();
  return readStoredList('promptly-habits').map((habit) => (
    habit.lastResetDate === today
      ? habit
      : {
          ...habit,
          doneToday: false,
          lastResetDate: today,
        }
  ));
}

export function getInitialDashboard() {
  return {
    urgentCount: 0,
    nextEvent: '',
    tasks: cleanStoredTasks(),
    reminders: readStoredList('promptly-reminders'),
    events: readStoredList('promptly-events'),
    habits: cleanStoredHabits(),
    cards: [],
  };
}

export async function getDesktopWidgetStatus() {
  try {
    const response = await fetch(`${API_BASE_URL}/desktop-widget/status`);
    if (!response.ok) throw new Error('Desktop widget status unavailable');
    return await response.json();
  } catch {
    return { hidden: false, offline: true };
  }
}

export async function setDesktopWidgetHidden(hidden) {
  try {
    const response = await fetch(`${API_BASE_URL}/desktop-widget/hidden`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hidden }),
    });
    if (!response.ok) throw new Error('Desktop widget state unavailable');
    return await response.json();
  } catch {
    return { hidden, offline: true };
  }
}

export async function requestDesktopWidgetUnhide() {
  try {
    const response = await fetch(`${API_BASE_URL}/desktop-widget/unhide`, {
      method: 'POST',
    });
    if (!response.ok) throw new Error('Desktop widget unhide unavailable');
    return await response.json();
  } catch {
    return { hidden: false, offline: true };
  }
}

export async function runAgent(message, category = 'study', history = [], appContext = {}) {
  try {
    const token = window.localStorage.getItem('promptly-auth-token');
    const response = await fetch(`${API_BASE_URL}/agent/run`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...getAuthHeaders(),
      },
      body: JSON.stringify({
        message,
        category,
        auto_create_tasks: Boolean(token),
        history: history.slice(-8).map(({ role, content }) => ({ role, content })),
        app_context: {
          tasks: (appContext.tasks || []).slice(0, 12).map((task) => ({
            id: task.id,
            title: task.title,
            category: task.category,
            priority: task.priority,
            status: task.status,
            deadline: task.deadline,
          })),
          events: (appContext.events || []).slice(0, 12).map((event) => ({
            id: event.id,
            title: event.title,
            task_id: event.task_id,
            start_time: event.start_time,
            end_time: event.end_time,
          })),
          reminders: (appContext.reminders || []).slice(0, 8).map((reminder) => ({
            id: reminder.id,
            title: reminder.title,
            due_at: reminder.due_at,
            time: reminder.time,
            status: reminder.status,
          })),
        },
      }),
    });

    if (!response.ok) throw new Error('Agent unavailable');
    return await response.json();
  } catch {
    return {
      title: 'Captured',
      badge: 'Local',
      model_source: 'local',
      reasoning: 'Backend unavailable, so no assumptions were added.',
      content: message,
      followUp: '',
      agent_steps: [],
      actions: [],
      suggested_tasks: [],
      suggested_reminders: [],
      schedule_blocks: [],
    };
  }
}

export async function getBackendTasks() {
  if (!hasBackendSession()) return null;
  const response = await fetch(`${API_BASE_URL}/tasks`, { headers: getAuthHeaders() });
  if (!response.ok) throw new Error('Could not load backend tasks');
  return response.json();
}

export async function getBackendEvents() {
  if (!hasBackendSession()) return null;
  const response = await fetch(`${API_BASE_URL}/calendar/events`, { headers: getAuthHeaders() });
  if (!response.ok) throw new Error('Could not load backend calendar events');
  return response.json();
}

export async function getBackendReminders() {
  if (!hasBackendSession()) return null;
  const response = await fetch(`${API_BASE_URL}/reminders`, { headers: getAuthHeaders() });
  if (!response.ok) throw new Error('Could not load backend reminders');
  return response.json();
}

export async function getAgentDigest() {
  if (!hasBackendSession()) return null;
  const response = await fetch(`${API_BASE_URL}/agent/digest`, { headers: getAuthHeaders() });
  if (!response.ok) throw new Error('Could not load agent digest');
  return response.json();
}

export async function createBackendTask(task) {
  if (!hasBackendSession()) return null;
  const response = await fetch(`${API_BASE_URL}/tasks`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...getAuthHeaders(),
    },
    body: JSON.stringify(task),
  });
  if (!response.ok) throw new Error('Could not create backend task');
  return response.json();
}

export async function updateBackendTask(taskId, updates) {
  if (!hasBackendSession()) return null;
  const response = await fetch(`${API_BASE_URL}/tasks/${taskId}`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      ...getAuthHeaders(),
    },
    body: JSON.stringify(updates),
  });
  if (!response.ok) throw new Error('Could not update backend task');
  return response.json();
}

export async function createBackendCalendarEvent(event) {
  if (!hasBackendSession()) return null;
  const response = await fetch(`${API_BASE_URL}/calendar/events`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...getAuthHeaders(),
    },
    body: JSON.stringify(event),
  });
  if (!response.ok) throw new Error('Could not create backend calendar event');
  return response.json();
}

export async function deleteBackendCalendarEvent(eventId) {
  if (!hasBackendSession()) return false;
  const response = await fetch(`${API_BASE_URL}/calendar/events/${eventId}`, {
    method: 'DELETE',
    headers: getAuthHeaders(),
  });
  if (!response.ok) throw new Error('Could not delete backend calendar event');
  return true;
}

export async function createBackendReminder(reminder) {
  if (!hasBackendSession()) return null;
  const response = await fetch(`${API_BASE_URL}/reminders`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...getAuthHeaders(),
    },
    body: JSON.stringify(reminder),
  });
  if (!response.ok) throw new Error('Could not create backend reminder');
  return response.json();
}

export async function deleteBackendTask(taskId) {
  if (!hasBackendSession()) return false;
  const response = await fetch(`${API_BASE_URL}/tasks/${taskId}`, {
    method: 'DELETE',
    headers: getAuthHeaders(),
  });
  if (!response.ok) throw new Error('Could not delete backend task');
  return true;
}

export async function deleteBackendReminder(reminderId) {
  if (!hasBackendSession()) return false;
  const response = await fetch(`${API_BASE_URL}/reminders/${reminderId}`, {
    method: 'DELETE',
    headers: getAuthHeaders(),
  });
  if (!response.ok) throw new Error('Could not delete backend reminder');
  return true;
}

export async function getCalendarEvents() {
  try {
    const response = await fetch(`${API_BASE_URL}/google-calendar/events`, { headers: getAuthHeaders() });
    if (!response.ok) throw new Error('Calendar unavailable');
    return await response.json();
  } catch {
    return [];
  }
}

export async function deleteGoogleCalendarEvent(eventId) {
  const response = await fetch(`${API_BASE_URL}/google-calendar/events/${encodeURIComponent(eventId)}`, {
    method: 'DELETE',
    headers: getAuthHeaders(),
  });
  if (!response.ok) throw new Error('Could not delete Google Calendar event');
  return true;
}

export async function getCalendarStatus() {
  try {
    const response = await fetch(`${API_BASE_URL}/google-calendar/status`, { headers: getAuthHeaders() });
    if (!response.ok) throw new Error('Calendar status unavailable');
    return await response.json();
  } catch {
    return {
      configured: false,
      authorized: false,
      offline: true,
    };
  }
}

export async function getCalendarAuthUrl() {
  const response = await fetch(`${API_BASE_URL}/google-calendar/auth-url`, { headers: getAuthHeaders() });
  if (!response.ok) {
    let detail = 'Could not create Google auth URL';
    try {
      const data = await response.json();
      detail = data.detail || detail;
    } catch {
      detail = await response.text() || detail;
    }
    throw new Error(detail);
  }
  const data = await response.json();
  return data.authorization_url;
}

export async function getAgentStatus() {
  try {
    const response = await fetch(`${API_BASE_URL}/agent/status`);
    if (!response.ok) throw new Error('Agent status unavailable');
    return await response.json();
  } catch {
    return {
      backend: 'offline',
      mode: 'fallback',
      model_ready: false,
      last_error: 'AI backend is offline.',
    };
  }
}
