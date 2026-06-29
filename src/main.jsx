import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AnimatePresence, motion } from 'framer-motion';
import {
  getAgentStatus,
  getAgentDigest,
  getBackendEvents,
  getBackendReminders,
  getBackendTasks,
  createBackendCalendarEvent,
  createBackendReminder,
  createBackendTask,
  deleteBackendCalendarEvent,
  updateBackendTask,
  getCalendarAuthUrl,
  getCalendarEvents,
  getCalendarStatus,
  deleteGoogleCalendarEvent,
  getInitialDashboard,
  hasBackendSession,
  requestDesktopWidgetUnhide,
  consumeGoogleAuthRedirect,
  deleteBackendTask,
  deleteBackendReminder,
  ensureDesktopSession,
  getCurrentUser,
  getGoogleLoginUrl,
  getStoredAuthUser,
  logoutBackendSession,
  runAgent,
  setDesktopWidgetHidden,
} from './lib/agentClient';
import { getAnalytics, getDailyBriefing, getLiveRecommendations, getPrioritizedTasks, getTaskProgress } from './lib/productivityEngine';
import './styles.css';

const categories = ['Study', 'Work', 'Personal'];
const weekdayLabels = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const junkTaskTitles = new Set([
  'hi', 'hey', 'hello', 'ok', 'okay', 'thanks', 'thank you', 'yes', 'no',
  'yep', 'nope', 'sure', 'cool', 'nice', 'that', 'it', 'this', 'those',
  'them', 'yo', 'sup', 'lol', 'haha', 'untitled task',
]);

function isAffirmativeReply(value) {
  return /^(yes|yep|yeah|y|sure|ok|okay|confirm|do it|delete it|add it)$/i.test(String(value || '').trim());
}

function isNegativeReply(value) {
  return /^(no|nope|nah|n|cancel|keep it|don't|dont|stop)$/i.test(String(value || '').trim());
}

function TrashIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" d="M4 7h16M9 7V4h6v3m3 0-1 13H7L6 7m4 4v5m4-5v5" />
    </svg>
  );
}

function RefreshIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" d="M20 11a8 8 0 1 0-2.34 5.66M20 4v7h-7" />
    </svg>
  );
}

function UndoIcon({ redo = false }) {
  return (
    <svg viewBox="0 0 24 24" className={`h-4 w-4 ${redo ? '-scale-x-100' : ''}`} fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" d="M9 7 4 12l5 5M5 12h8a6 6 0 0 1 6 6" />
    </svg>
  );
}

function prependUniqueByTitle(previous, incoming) {
  const existingTitles = new Set(
    previous.map((item) => normalizeTitleForIdentity(item.title)).filter(Boolean),
  );
  const unique = incoming.filter((item) => {
    const title = normalizeTitleForIdentity(item.title);
    if (!title || existingTitles.has(title)) return false;
    existingTitles.add(title);
    return true;
  });
  return unique.length ? [...unique, ...previous] : previous;
}

function cleanTaskTitle(title) {
  const text = String(title || '').trim();
  const malformedReminder = text.match(/^a\s+to\s+(.+)$/i);
  if (!malformedReminder) return text;
  const cleanTitle = malformedReminder[1].trim();
  return cleanTitle.charAt(0).toUpperCase() + cleanTitle.slice(1);
}

function normalizeTitleForIdentity(title) {
  return cleanTaskTitle(title).trim().toLowerCase().replace(/\s+/g, ' ');
}

function normalizeTaskRecord(task) {
  if (!task) return task;
  const title = cleanTaskTitle(task.title);
  return title === task.title ? task : { ...task, title };
}

function dedupeTasksByTitle(taskList) {
  const seen = new Set();
  return (taskList || [])
    .map(normalizeTaskRecord)
    .filter((task) => {
      const key = normalizeTitleForIdentity(task?.title);
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

function parseActionDateTime(value) {
  if (!value || value === 'Needs date') return null;
  const direct = new Date(value);
  if (!Number.isNaN(direct.getTime())) return direct;
  const text = String(value).toLowerCase();
  const time = text.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i);
  if (!time) return null;
  let hour = Number(time[1]);
  const minute = Number(time[2] || 0);
  const meridiem = time[3].toLowerCase();
  if (meridiem === 'pm' && hour < 12) hour += 12;
  if (meridiem === 'am' && hour === 12) hour = 0;

  const now = new Date();
  const result = new Date(now);
  const monthNames = {
    jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2,
    apr: 3, april: 3, may: 4, jun: 5, june: 5, jul: 6, july: 6,
    aug: 7, august: 7, sep: 8, sept: 8, september: 8, oct: 9,
    october: 9, nov: 10, november: 10, dec: 11, december: 11,
  };
  const monthPattern = Object.keys(monthNames).join('|');
  const monthFirst = text.match(new RegExp(`\\b(${monthPattern})\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`, 'i'));
  const dayFirst = text.match(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?(?:\\s+of)?\\s+(${monthPattern})\\b`, 'i'));
  const ordinalDay = text.match(/\b(?:on\s+)?(\d{1,2})(?:st|nd|rd|th)\b/i);

  if (monthFirst || dayFirst) {
    const monthName = (monthFirst?.[1] || dayFirst?.[2]).toLowerCase();
    const day = Number(monthFirst?.[2] || dayFirst?.[1]);
    result.setFullYear(now.getFullYear(), monthNames[monthName], day);
    if (result < now) result.setFullYear(result.getFullYear() + 1);
  } else if (ordinalDay) {
    const day = Number(ordinalDay[1]);
    result.setDate(1);
    result.setMonth(now.getMonth(), day);
    if (result < now) result.setMonth(result.getMonth() + 1, day);
  } else if (text.includes('tomorrow')) {
    result.setDate(result.getDate() + 1);
  }
  result.setHours(hour, minute, 0, 0);
  return result;
}

function escapeCsvCell(value) {
  const text = String(value ?? '');
  return `"${text.replaceAll('"', '""')}"`;
}

function downloadTaskExport(tasks, format) {
  const content = format === 'json'
    ? JSON.stringify(tasks, null, 2)
    : [
        ['Title', 'Category', 'Priority', 'Status', 'Deadline', 'Estimated minutes'],
        ...tasks.map((task) => [
          task.title,
          task.category,
          task.priority,
          task.status,
          task.deadline || '',
          task.estimated_time || String(task.estimate || '').replace(/\D/g, ''),
        ]),
      ].map((row) => row.map(escapeCsvCell).join(',')).join('\n');
  const blob = new Blob([content], {
    type: format === 'json' ? 'application/json' : 'text/csv',
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `promptly-tasks-${getLocalDateKey()}.${format}`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

function getInitialChatMessages() {
  try {
    const stored = JSON.parse(window.localStorage.getItem('promptly-chat') || '[]');
    if (Array.isArray(stored) && stored.length) return stored;
  } catch {
    // Start a fresh conversation if stored chat data is invalid.
  }
  return [{
    id: 'welcome',
    role: 'assistant',
    content: 'Tell me what you need to do. I can add tasks, schedule them, and update their time.',
  }];
}

function useSpeechInput(setInput) {
  const [isListening, setIsListening] = useState(false);
  const recognitionRef = useRef(null);

  const supported = useMemo(
    () => typeof window !== 'undefined' && ('webkitSpeechRecognition' in window || 'SpeechRecognition' in window),
    [],
  );

  useEffect(() => {
    if (!supported) return;
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    const recognition = new SpeechRecognition();
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.lang = 'en-US';

    recognition.onstart = () => setIsListening(true);
    recognition.onend = () => setIsListening(false);
    recognition.onerror = () => setIsListening(false);
    recognition.onresult = (event) => {
      let transcript = '';
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        transcript += event.results[i][0].transcript;
      }
      setInput(transcript);
    };
    recognitionRef.current = recognition;
  }, [setInput, supported]);

  return {
    supported,
    isListening,
    start: () => recognitionRef.current?.start(),
  };
}

function getCorrectionIntent(message) {
  const lower = message.trim().toLowerCase();
  if (!lower) return null;
  const wantsPm = /\bpm\b/.test(lower) && /\bnot\s+am\b|\binstead\s+of\s+am\b|\bchange.*am\b/.test(lower);
  const wantsAm = /\bam\b/.test(lower) && /\bnot\s+pm\b|\binstead\s+of\s+pm\b|\bchange.*pm\b/.test(lower);
  const timeMatch = lower.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/);

  if (!wantsPm && !wantsAm && !/\b(change|move|shift|update|actually)\b/.test(lower)) return null;

  return {
    meridiem: wantsPm ? 'PM' : wantsAm ? 'AM' : timeMatch?.[3]?.toUpperCase(),
    hour: timeMatch ? Number(timeMatch[1]) : null,
    minute: timeMatch ? Number(timeMatch[2] || 0) : null,
  };
}

function applyCorrectionToDeadline(deadline, intent) {
  const base = deadline || 'Today 11:00 AM';
  const parsed = new Date(base);
  let prefix = String(base);
  let hour = intent.hour;
  let minute = intent.minute ?? 0;
  let meridiem = intent.meridiem;

  if (!Number.isNaN(parsed.getTime())) {
    const next = new Date(parsed);
    if (!hour) hour = next.getHours() > 12 ? next.getHours() - 12 : next.getHours();
    if (!meridiem) meridiem = next.getHours() >= 12 ? 'PM' : 'AM';
    let normalizedHour = hour;
    if (meridiem === 'PM' && normalizedHour < 12) normalizedHour += 12;
    if (meridiem === 'AM' && normalizedHour === 12) normalizedHour = 0;
    next.setHours(normalizedHour, minute, 0, 0);
    return next.toISOString();
  }

  const existingTime = String(base).match(/(\d{1,2})(?::(\d{2}))?\s*(AM|PM)?/i);
  if (!hour) hour = existingTime ? Number(existingTime[1]) : 11;
  if (intent.minute === null && existingTime?.[2]) minute = Number(existingTime[2]);
  if (!meridiem) meridiem = existingTime?.[3]?.toUpperCase() || 'PM';
  prefix = String(base).replace(/(\d{1,2})(?::(\d{2}))?\s*(AM|PM)?/i, '').trim() || 'Today';
  return `${prefix} ${hour}:${String(minute).padStart(2, '0')} ${meridiem}`;
}

function MiniMode({ urgentCount, nextEvent, onExpand }) {
  const handlePointerDown = (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const isDesktopApp = Boolean(window.promptlyDesktop);
    const origin = {
      x: event.screenX,
      y: event.screenY,
      lastX: event.screenX,
      lastY: event.screenY,
      moved: false,
    };
    const handlePointerMove = (moveEvent) => {
      const deltaX = moveEvent.screenX - origin.lastX;
      const deltaY = moveEvent.screenY - origin.lastY;
      const totalX = moveEvent.screenX - origin.x;
      const totalY = moveEvent.screenY - origin.y;
      if (Math.abs(totalX) + Math.abs(totalY) > 3) origin.moved = true;
      if (isDesktopApp && (deltaX || deltaY)) {
        window.promptlyDesktop?.moveBy?.(deltaX, deltaY);
        origin.lastX = moveEvent.screenX;
        origin.lastY = moveEvent.screenY;
      }
    };
    const handlePointerUp = () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
      if (!origin.moved) onExpand();
    };
    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp, { once: true });
  };

  return (
    <div
      className="relative grid h-full w-full place-items-center rounded-full border border-white/20 bg-slate-950/55 text-white shadow-[0_10px_28px_rgba(8,145,178,0.24)] backdrop-blur-xl"
      title={nextEvent ? `Promptly: ${nextEvent}` : 'Drag Promptly'}
    >
      <motion.button
        type="button"
        onPointerDown={handlePointerDown}
        className="grid h-9 w-9 cursor-grab place-items-center rounded-full active:cursor-grabbing"
        initial={{ scale: 0.86, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        whileHover={{ scale: 1.08 }}
        whileTap={{ scale: 0.96 }}
      >
        <div className="relative grid h-5 w-5 place-items-center rounded-full bg-[radial-gradient(circle_at_30%_20%,#67e8f9,#6366f1_48%,#020617_100%)]">
          {urgentCount ? (
            <span className="absolute -right-1 -top-1 grid h-3 w-3 place-items-center rounded-full border border-white/40 bg-rose-500 text-[7px] font-black leading-none">
              {urgentCount > 9 ? '9+' : urgentCount}
            </span>
          ) : null}
          <span className="text-[10px] font-black leading-none">P</span>
        </div>
      </motion.button>
    </div>
  );
}

function SmartCard({ card }) {
  const tone = {
    cyan: 'from-cyan-400/20 to-sky-500/10 border-cyan-200/20',
    violet: 'from-violet-400/20 to-fuchsia-500/10 border-violet-200/20',
    amber: 'from-amber-400/20 to-orange-500/10 border-amber-200/20',
  }[card.tone] || 'from-white/10 to-white/5 border-white/10';

  return (
    <motion.div
      className={`rounded-3xl border bg-gradient-to-br ${tone} p-4 shadow-lg shadow-slate-950/20`}
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
    >
      <p className="text-[11px] font-black uppercase tracking-[0.2em] text-slate-400">{card.type}</p>
      <h3 className="mt-2 text-base font-black text-white">{card.title}</h3>
      <p className="mt-2 text-sm leading-5 text-slate-300">{card.detail}</p>
    </motion.div>
  );
}

function BriefingPanel({ briefing, onBlockFreeSlot, onRecoverTask }) {
  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
  const freeSlot = briefing.freeSlot;
  const missedTask = briefing.missedTasks?.[0];
  const formatSlotTime = (date) => date?.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

  return (
    <section className="rounded-3xl border border-cyan-300/15 bg-cyan-300/[0.06] p-4">
      <div className="mb-3 flex items-center justify-between">
        <div>
          <p className="text-[10px] font-black uppercase tracking-[0.2em] text-cyan-100/60">Today briefing</p>
          <h2 className="mt-1 font-black text-white">{greeting}. Today&apos;s top 3</h2>
        </div>
        <span className="rounded-full bg-cyan-300/15 px-3 py-1 text-xs font-black text-cyan-100">
          {briefing.workloadLabel}
        </span>
      </div>
      <div className="grid gap-3 md:grid-cols-3">
        {briefing.topTasks.length ? briefing.topTasks.map((task, index) => (
          <div key={task.id || `brief-${task.title}`} className="rounded-2xl border border-white/10 bg-slate-950/35 p-3">
            <p className="text-[10px] font-black uppercase tracking-[0.16em] text-slate-500">Priority {index + 1}</p>
            <h3 className="mt-2 truncate text-sm font-black text-white">{task.title}</h3>
            <p className={`mt-2 text-xs font-bold ${
              task.priorityMeta.overdue ? 'text-rose-200' : 'text-cyan-100'
            }`}>
              {task.priorityMeta.overdue
                ? 'Overdue'
                : task.priority === 'high'
                  ? 'High priority'
                  : `${task.estimated_time || Number.parseInt(task.estimate || 45, 10) || 45} min`}
            </p>
            <p className="mt-1 text-xs leading-5 text-slate-400">{task.priorityMeta.explanation}</p>
            <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-white/10">
              <div className="h-full rounded-full bg-cyan-300" style={{ width: `${task.priorityMeta.score}%` }} />
            </div>
          </div>
        )) : (
          <div className="rounded-2xl border border-dashed border-white/10 bg-slate-950/25 p-3 text-sm text-slate-400 md:col-span-3">
            Add a task and Promptly will build your Top 3.
          </div>
        )}
      </div>
      <div className="mt-3 grid gap-2 text-xs text-slate-300 sm:grid-cols-3">
        <div className="rounded-2xl bg-white/[0.05] p-3">Urgent deadlines: {briefing.urgentDeadlines.length}</div>
        <div className="rounded-2xl bg-white/[0.05] p-3">Calendar events: {briefing.eventCount}</div>
        <div className="rounded-2xl bg-white/[0.05] p-3">Habit consistency: {briefing.habitConsistency}%</div>
      </div>
      <div className="mt-3 grid gap-3 lg:grid-cols-2">
        {freeSlot ? (
          <div className="rounded-2xl border border-cyan-300/20 bg-slate-950/30 p-3">
            <p className="text-[10px] font-black uppercase tracking-[0.16em] text-cyan-100/60">Free slot found</p>
            <p className="mt-2 text-sm font-bold text-white">
              You&apos;re free {formatSlotTime(freeSlot.start)}–{formatSlotTime(freeSlot.end)}.
            </p>
            <p className="mt-1 text-xs text-slate-400">Block it for {freeSlot.task.title}?</p>
            <button
              type="button"
              onClick={() => onBlockFreeSlot(freeSlot)}
              className="mt-3 rounded-full bg-cyan-300 px-3 py-2 text-xs font-black text-slate-950"
            >
              Block time
            </button>
          </div>
        ) : null}
        {missedTask ? (
          <div className="rounded-2xl border border-rose-300/20 bg-rose-300/[0.06] p-3">
            <p className="text-[10px] font-black uppercase tracking-[0.16em] text-rose-100/60">Missed task recovery</p>
            <p className="mt-2 text-sm font-bold text-white">You missed {missedTask.title}.</p>
            <p className="mt-1 text-xs text-slate-400">Choose a realistic recovery slot.</p>
            <div className="mt-3 flex gap-2">
              <button type="button" onClick={() => onRecoverTask(missedTask, 'tonight')} className="rounded-full bg-white/10 px-3 py-2 text-xs font-black text-white hover:bg-white/20">
                Tonight
              </button>
              <button type="button" onClick={() => onRecoverTask(missedTask, 'tomorrow')} className="rounded-full bg-rose-300/20 px-3 py-2 text-xs font-black text-rose-100 hover:bg-rose-300/30">
                Tomorrow morning
              </button>
            </div>
          </div>
        ) : null}
      </div>
    </section>
  );
}

function FocusPanel({ sessions, activeFocus, onStartFocus, onStopFocus, onAddFocusSession, onDeleteFocusSession }) {
  const [secondsRemaining, setSecondsRemaining] = useState(0);
  const [isPaused, setIsPaused] = useState(false);
  const [timerSessionId, setTimerSessionId] = useState(null);
  const [title, setTitle] = useState('');
  const [start, setStart] = useState('');
  const [duration, setDuration] = useState(25);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setSecondsRemaining(activeFocus ? Math.max(1, Number(activeFocus.duration || 25)) * 60 : 0);
    setIsPaused(false);
    setTimerSessionId(activeFocus?.id ?? null);
  }, [activeFocus]);

  useEffect(() => {
    if (!activeFocus || isPaused || secondsRemaining <= 0) return undefined;
    const timer = window.setInterval(() => {
      setSecondsRemaining((current) => Math.max(0, current - 1));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [activeFocus, isPaused, secondsRemaining]);

  useEffect(() => {
    if (!activeFocus || timerSessionId !== activeFocus.id || secondsRemaining !== 0) return;
    window.promptlyDesktop?.notify?.(
      'Focus session complete',
      `${activeFocus.title} is done. Take a short break before the next block.`,
    );
  }, [activeFocus, secondsRemaining, timerSessionId]);

  const minutes = Math.floor(secondsRemaining / 60);
  const seconds = String(secondsRemaining % 60).padStart(2, '0');

  const submitFocusSession = async (event) => {
    event.preventDefault();
    const cleanTitle = title.trim();
    if (!cleanTitle || !start || saving) return;
    setSaving(true);
    try {
      await onAddFocusSession({
        title: cleanTitle,
        start: new Date(start),
        duration: Math.max(5, Number(duration) || 25),
      });
      setTitle('');
      setStart('');
      setDuration(25);
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="rounded-3xl border border-white/10 bg-white/[0.05] p-4">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="font-black">Focus sessions</h2>
        {activeFocus ? (
          <button type="button" onClick={onStopFocus} className="rounded-full bg-rose-400/20 px-3 py-1 text-xs font-black text-rose-100">
            Stop
          </button>
        ) : null}
      </div>
      {activeFocus ? (
        <div className="mb-3 rounded-2xl border border-cyan-300/25 bg-cyan-300/10 p-3">
          <p className="text-xs font-black uppercase tracking-[0.16em] text-cyan-100/70">Running now</p>
          <h3 className="mt-2 text-sm font-black text-white">{activeFocus.title}</h3>
          <div className="mt-3 flex items-end justify-between gap-3">
            <p className="font-mono text-3xl font-black tabular-nums text-cyan-100">
              {minutes}:{seconds}
            </p>
            <button
              type="button"
              onClick={() => setIsPaused((current) => !current)}
              className="rounded-full bg-white/10 px-3 py-1.5 text-xs font-black text-cyan-50 hover:bg-white/20"
            >
              {isPaused ? 'Resume' : 'Pause'}
            </button>
          </div>
        </div>
      ) : null}
      <form onSubmit={submitFocusSession} className="mb-3 rounded-2xl border border-cyan-300/15 bg-cyan-300/[0.06] p-3">
        <p className="text-[10px] font-black uppercase tracking-[0.16em] text-cyan-100/60">Manual focus</p>
        <div className="mt-2 grid gap-2">
          <input
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="Focus session title"
            className="rounded-xl border border-white/10 bg-slate-950/45 px-3 py-2 text-sm font-bold text-white outline-none placeholder:text-slate-500 focus:border-cyan-200/70"
          />
          <div className="grid grid-cols-[1fr_88px] gap-2">
            <input
              type="datetime-local"
              value={start}
              onChange={(event) => setStart(event.target.value)}
              className="min-w-0 rounded-xl border border-white/10 bg-slate-950/45 px-3 py-2 text-sm font-bold text-slate-200 outline-none focus:border-cyan-200/70"
            />
            <input
              type="number"
              min="5"
              step="5"
              value={duration}
              onChange={(event) => setDuration(event.target.value)}
              className="rounded-xl border border-white/10 bg-slate-950/45 px-3 py-2 text-sm font-bold text-slate-200 outline-none focus:border-cyan-200/70"
              aria-label="Duration in minutes"
            />
          </div>
          <button
            type="submit"
            disabled={!title.trim() || !start || saving}
            className="rounded-xl bg-cyan-300 px-3 py-2 text-xs font-black text-slate-950 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {saving ? 'Adding focus' : 'Add focus session'}
          </button>
        </div>
      </form>
      <div className="space-y-2">
        {sessions.length ? sessions.map((session) => (
          <div
            key={session.id}
            className="rounded-2xl border border-white/10 bg-slate-950/35 p-3 transition hover:border-cyan-300/35"
          >
            <div className="flex items-start justify-between gap-3">
              <button
                type="button"
                onClick={() => onStartFocus(session)}
                className="min-w-0 flex-1 text-left"
              >
                <p className="truncate text-sm font-black text-white">{session.title}</p>
                <p className="mt-1 text-xs text-slate-400">{session.startLabel || 'Manual focus block'}</p>
              </button>
              <div className="flex shrink-0 items-center gap-2">
                <span className="rounded-full bg-white/10 px-2 py-1 text-[10px] font-black text-slate-300">
                  {session.duration}m
                </span>
                <button
                  type="button"
                  onClick={() => onDeleteFocusSession(session)}
                  className="grid h-7 w-7 place-items-center rounded-full bg-rose-500/15 text-rose-200 transition hover:bg-rose-500/35"
                  title={`Delete ${session.title}`}
                  aria-label={`Delete ${session.title}`}
                >
                  <TrashIcon />
                </button>
              </div>
            </div>
          </div>
        )) : (
          <div className="rounded-2xl border border-dashed border-white/10 bg-white/[0.03] p-3 text-xs text-slate-500">
            No focus sessions yet. Add one here or ask the chatbot to add a focus session.
          </div>
        )}
      </div>
    </section>
  );
}

function HabitRow({ habit, onToggle, onDelete }) {
  return (
    <div
      className={`relative flex items-center rounded-2xl border transition ${
        habit.doneToday
          ? 'border-emerald-300/25 bg-emerald-300/10'
          : 'border-white/10 bg-slate-950/35 hover:border-cyan-300/25'
      }`}
    >
      <button
        type="button"
        onClick={() => onToggle(habit.id)}
        className="flex min-w-0 flex-1 items-center justify-between gap-3 p-3 text-left"
      >
        <span className="text-sm font-black text-white">{habit.title}</span>
        <span className="shrink-0 rounded-full bg-white/10 px-2 py-1 text-[10px] font-black text-slate-300">
          {habit.streak} day streak
        </span>
      </button>
      <button
        type="button"
        onClick={() => onDelete(habit.id)}
        className="mr-3 grid h-8 w-8 shrink-0 place-items-center rounded-full bg-rose-500/10 text-rose-200 transition hover:bg-rose-500/30"
        title="Delete habit"
        aria-label={`Delete ${habit.title}`}
      >
        <TrashIcon />
      </button>
    </div>
  );
}

function HabitPanel({ habits, onToggleHabit, onAddHabit, onDeleteHabit }) {
  const [habitInput, setHabitInput] = useState('');
  const submitHabit = () => {
    const title = habitInput.trim();
    if (!title) return;
    onAddHabit(title);
    setHabitInput('');
  };

  return (
    <section className="rounded-3xl border border-white/10 bg-white/[0.05] p-4">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="font-black">Habit tracker</h2>
        <span className="rounded-full bg-white/10 px-2 py-1 text-[10px] font-black text-slate-300">
          {habits.length} habits
        </span>
      </div>
      <div className="mb-3 flex gap-2 rounded-2xl border border-white/10 bg-slate-950/35 p-2">
        <input
          value={habitInput}
          onChange={(event) => setHabitInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              submitHabit();
            }
          }}
          placeholder="Add a habit..."
          className="min-w-0 flex-1 bg-transparent px-2 text-sm text-white outline-none placeholder:text-slate-500"
        />
        <button
          type="button"
          onClick={submitHabit}
          disabled={!habitInput.trim()}
          className="rounded-full bg-cyan-300 px-3 py-2 text-xs font-black text-slate-950 disabled:opacity-40"
        >
          Add
        </button>
      </div>
      <div className="space-y-2">
        {habits.length ? habits.map((habit) => (
          <HabitRow
            key={habit.id}
            habit={habit}
            onToggle={onToggleHabit}
            onDelete={onDeleteHabit}
          />
        )) : (
          <div className="rounded-2xl border border-dashed border-white/10 bg-white/[0.03] p-3 text-xs text-slate-500">
            Add your first habit to start tracking streaks.
          </div>
        )}
      </div>
    </section>
  );
}

function AnalyticsPanel({ analytics }) {
  if (!analytics.hasEnoughData) {
    return (
      <section className="rounded-3xl border border-white/10 bg-white/[0.05] p-4">
        <h2 className="font-black">Productivity analytics</h2>
        <div className="mt-3 rounded-2xl border border-dashed border-white/10 bg-slate-950/25 p-4">
          <p className="text-sm font-bold text-slate-200">Building your baseline</p>
          <p className="mt-1 text-xs leading-5 text-slate-400">
            Complete {Math.max(0, 3 - analytics.completed)} more task{3 - analytics.completed === 1 ? '' : 's'} to unlock meaningful trends.
          </p>
        </div>
      </section>
    );
  }
  const stats = [
    ['Completed', analytics.completed],
    ['Rate', `${analytics.completionRate}%`],
    ['Missed', analytics.missed],
    ['Score', analytics.productivityScore],
  ];
  return (
    <section className="rounded-3xl border border-white/10 bg-white/[0.05] p-4">
      <h2 className="mb-3 font-black">Productivity analytics</h2>
      <div className="grid grid-cols-2 gap-2">
        {stats.map(([label, value]) => (
          <div key={label} className="rounded-2xl border border-white/10 bg-slate-950/35 p-3">
            <p className="text-[10px] font-black uppercase tracking-[0.16em] text-slate-500">{label}</p>
            <p className="mt-1 text-lg font-black text-white">{value}</p>
          </div>
        ))}
      </div>
      <p className="mt-3 text-xs text-slate-400">Most productive hour: {analytics.mostProductiveHour}</p>
    </section>
  );
}

function QuickTaskActions({ task, onComplete, onReschedule, onAddReminder }) {
  const [showSchedule, setShowSchedule] = useState(false);
  const [dateTime, setDateTime] = useState('');
  if (!task) return null;

  return (
    <section className="rounded-3xl border border-white/10 bg-white/[0.05] p-4">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[10px] font-black uppercase tracking-[0.18em] text-cyan-200/70">Quick actions</p>
          <h2 className="mt-1 truncate font-black text-white">{task.title}</h2>
        </div>
        <span className="rounded-full bg-white/10 px-2 py-1 text-[10px] font-black text-slate-300">
          {task.estimate || `${task.estimated_time || 45}m`}
        </span>
      </div>
      <div className="mt-3 grid grid-cols-3 gap-2">
        <button type="button" onClick={() => onComplete(task.id)} className="rounded-xl bg-emerald-300/15 px-2 py-2 text-xs font-black text-emerald-100 hover:bg-emerald-300/25">
          Complete
        </button>
        <button type="button" onClick={() => setShowSchedule((current) => !current)} className="rounded-xl bg-white/10 px-2 py-2 text-xs font-black text-slate-200 hover:bg-white/20">
          Reschedule
        </button>
        <button type="button" onClick={() => onAddReminder(task)} className="rounded-xl bg-cyan-300/15 px-2 py-2 text-xs font-black text-cyan-100 hover:bg-cyan-300/25">
          Add reminder
        </button>
      </div>
      {showSchedule ? (
        <div className="mt-3 flex gap-2 rounded-2xl border border-white/10 bg-slate-950/35 p-2">
          <input
            type="datetime-local"
            value={dateTime}
            onChange={(event) => setDateTime(event.target.value)}
            className="min-w-0 flex-1 bg-transparent px-2 text-xs text-slate-200 outline-none"
          />
          <button
            type="button"
            disabled={!dateTime}
            onClick={() => {
              onReschedule(task.id, new Date(dateTime).toISOString());
              setShowSchedule(false);
              setDateTime('');
            }}
            className="rounded-xl bg-cyan-300 px-3 py-2 text-xs font-black text-slate-950 disabled:opacity-40"
          >
            Save
          </button>
        </div>
      ) : null}
    </section>
  );
}

function TaskBreakdown({ task, onToggleSubtask }) {
  if (!task) return null;
  const progress = getTaskProgress(task);
  return (
    <section className="rounded-3xl border border-white/10 bg-white/[0.05] p-4">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="font-black">Task breakdown</h2>
        <span className="rounded-full bg-white/10 px-3 py-1 text-xs font-black text-slate-300">
          {progress.percent}%
        </span>
      </div>
      <h3 className="truncate text-sm font-black text-white">{task.title}</h3>
      <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-white/10">
        <div className="h-full rounded-full bg-emerald-300" style={{ width: `${progress.percent}%` }} />
      </div>
      <div className="mt-3 space-y-2">
        {progress.subtasks.map((subtask) => (
          <button
            key={subtask.id}
            type="button"
            onClick={() => onToggleSubtask(task.id, subtask.id)}
            className="flex w-full items-center gap-2 rounded-xl bg-slate-950/35 px-3 py-2 text-left text-xs text-slate-300"
          >
            <span className={`grid h-4 w-4 place-items-center rounded border text-[9px] ${subtask.done ? 'border-emerald-300 bg-emerald-300 text-slate-950' : 'border-white/20'}`}>
              {subtask.done ? '✓' : ''}
            </span>
            <span className={subtask.done ? 'line-through opacity-60' : ''}>{subtask.title}</span>
          </button>
        ))}
      </div>
    </section>
  );
}

function isTaskComplete(task) {
  return String(task.status || '').toLowerCase() === 'completed';
}

function isUrgentTask(task) {
  if (isTaskComplete(task)) return false;
  if (String(task.priority || '').toLowerCase() === 'high') return true;
  if (task.priorityMeta?.overdue || task.priorityMeta?.score >= 65) return true;
  const importantDeadlineTask = /assignment|exam|test|quiz|project|submission|submit|report|presentation|interview/i.test(
    task.title || '',
  );
  return importantDeadlineTask && Boolean(task.deadline && task.deadline !== 'Needs date');
}

function TaskStatusPill({ label, count, tone = 'cyan' }) {
  const toneClass = tone === 'emerald'
    ? 'border-emerald-300/20 bg-emerald-300/10 text-emerald-100'
    : 'border-cyan-300/20 bg-cyan-300/10 text-cyan-100';
  return (
    <div className={`rounded-2xl border px-3 py-2 ${toneClass}`}>
      <p className="text-[10px] font-black uppercase tracking-[0.16em] opacity-70">{label}</p>
      <p className="mt-1 text-lg font-black">{count}</p>
    </div>
  );
}

function TaskRow({ task, onToggleComplete, onDelete, onMoveCategory, compact = false }) {
  const [selected, setSelected] = useState(false);
  const completed = isTaskComplete(task);
  const urgent = isUrgentTask(task);
  const currentCategory = String(task.category || '').toLowerCase();
  return (
    <div
      onClick={() => setSelected((current) => !current)}
      draggable={Boolean(task.id) && !completed}
      onDragStart={(event) => {
        event.dataTransfer.setData('text/plain', task.id);
        event.dataTransfer.effectAllowed = 'move';
      }}
      className={`relative rounded-2xl border p-3 transition ${
        completed
          ? 'border-emerald-300/15 bg-emerald-300/[0.06] opacity-80'
          : 'cursor-grab border-white/10 bg-white/[0.06] hover:border-cyan-300/25 active:cursor-grabbing'
      }`}
    >
      {selected && onDelete ? (
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onDelete(task.id);
          }}
          className="absolute left-2 top-2 z-10 grid h-7 w-7 place-items-center rounded-full bg-rose-500/20 text-rose-200 transition hover:bg-rose-500/40"
          title="Delete task"
          aria-label={`Delete ${task.title}`}
        >
          <TrashIcon />
        </button>
      ) : null}
      <div className={`flex items-start justify-between gap-3 ${selected && onDelete ? 'pl-8' : ''}`}>
        <div className="flex min-w-0 gap-3">
          {onToggleComplete ? (
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                onToggleComplete(task.id);
              }}
              className={`mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-md border text-[11px] font-black transition ${
                completed
                  ? 'border-emerald-300 bg-emerald-300 text-slate-950'
                  : 'border-white/20 bg-white/5 text-transparent hover:border-cyan-200 hover:text-cyan-100'
              }`}
              title={completed ? 'Mark active' : 'Mark completed'}
            >
              ✓
            </button>
          ) : null}
          <div className="min-w-0">
          <p className={`truncate text-sm font-bold ${completed ? 'text-slate-400 line-through' : 'text-white'}`}>{task.title}</p>
          <p className="mt-1 text-xs text-slate-400">
            {task.category} • {task.estimate || `${task.estimated_time || 45}m`} • {getFriendlyDateTime(task.deadline) || 'No deadline'}
          </p>
          </div>
        </div>
        {!compact ? (
          <span className={`shrink-0 rounded-full px-2 py-1 text-[10px] font-black uppercase ${
            completed
              ? 'bg-emerald-400/15 text-emerald-200'
              : urgent
                ? 'bg-rose-400/20 text-rose-200'
                : 'bg-cyan-400/15 text-cyan-200'
          }`}
          >
            {completed ? 'done' : urgent ? 'urgent' : task.priority}
          </span>
        ) : null}
      </div>
      {selected && onMoveCategory && !completed ? (
        <div className="mt-3 flex flex-wrap gap-2 border-t border-white/8 pt-3">
          {categories.map((item) => {
            const active = currentCategory === item.toLowerCase();
            return (
              <button
                key={item}
                type="button"
                disabled={active}
                onClick={(event) => {
                  event.stopPropagation();
                  onMoveCategory(task.id, item);
                  setSelected(false);
                }}
                className={`rounded-full px-3 py-1.5 text-[10px] font-black transition ${
                  active
                    ? 'cursor-default bg-cyan-300/25 text-cyan-50'
                    : 'bg-white/10 text-slate-200 hover:bg-cyan-300/20 hover:text-cyan-50'
                }`}
              >
                {active ? `${item} now` : `Move to ${item}`}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

function ManualTaskComposer({ onAdd, onCancel }) {
  const [title, setTitle] = useState('');
  const [selectedCategory, setSelectedCategory] = useState('Personal');
  const [deadline, setDeadline] = useState('');
  const [saving, setSaving] = useState(false);

  const submitManualTask = async (event) => {
    event.preventDefault();
    const cleanTitle = title.trim();
    if (!cleanTitle || saving) return;
    setSaving(true);
    try {
      await onAdd({
        title: cleanTitle,
        category: selectedCategory,
        deadline: deadline ? new Date(deadline).toISOString() : null,
      });
      setTitle('');
      setDeadline('');
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={submitManualTask} className="mb-3 rounded-2xl border border-cyan-300/15 bg-cyan-300/[0.06] p-3">
      <div className="mb-2 flex items-center justify-between gap-3">
        <div>
          <p className="text-[10px] font-black uppercase tracking-[0.16em] text-cyan-100/60">Manual task</p>
          <h3 className="text-sm font-black text-white">Add without chat</h3>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={saving}
            className="rounded-full bg-white/10 px-3 py-2 text-xs font-black text-slate-200 transition hover:bg-white/20 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={!title.trim() || saving}
            className="rounded-full bg-cyan-300 px-3 py-2 text-xs font-black text-slate-950 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {saving ? 'Adding' : 'Add'}
          </button>
        </div>
      </div>
      <input
        value={title}
        onChange={(event) => setTitle(event.target.value)}
        placeholder="Task title"
        className="w-full rounded-xl border border-white/10 bg-slate-950/45 px-3 py-2 text-sm font-bold text-white outline-none placeholder:text-slate-500 focus:border-cyan-200/70"
      />
      <div className="mt-2 grid grid-cols-3 gap-2">
        {categories.map((item) => {
          const active = selectedCategory === item;
          return (
            <button
              key={item}
              type="button"
              onClick={() => setSelectedCategory(item)}
              className={`rounded-xl border px-2 py-2 text-xs font-black transition ${
                active
                  ? 'border-cyan-200 bg-cyan-300/25 text-cyan-50'
                  : 'border-white/10 bg-white/[0.04] text-slate-300 hover:bg-white/[0.08]'
              }`}
            >
              {item}
            </button>
          );
        })}
      </div>
      <input
        type="datetime-local"
        value={deadline}
        onChange={(event) => setDeadline(event.target.value)}
        className="mt-2 w-full rounded-xl border border-white/10 bg-slate-950/45 px-3 py-2 text-sm font-bold text-slate-200 outline-none focus:border-cyan-200/70"
      />
    </form>
  );
}

function CategoryBoard({ title, tasks, onMoveTask, onToggleComplete, onDeleteTask }) {
  return (
    <div
      onDragOver={(event) => {
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
      }}
      onDrop={(event) => {
        event.preventDefault();
        const taskId = event.dataTransfer.getData('text/plain');
        if (taskId) onMoveTask(taskId, title);
      }}
      className="rounded-2xl border border-white/10 bg-slate-950/35 p-3 transition hover:border-cyan-300/30"
    >
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-sm font-black text-white">{title}</h3>
        <span className="rounded-full bg-white/10 px-2 py-1 text-[10px] font-black text-slate-300">
          {tasks.length}
        </span>
      </div>
      <div className="space-y-2">
        {tasks.length ? (
          tasks.slice(0, 3).map((task) => (
            <TaskRow
              key={task.id || `${title}-${task.title}`}
              task={task}
              onToggleComplete={onToggleComplete}
              onDelete={onDeleteTask}
              onMoveCategory={onMoveTask}
              compact
            />
          ))
        ) : (
          <div className="rounded-xl border border-dashed border-white/10 bg-white/[0.03] p-3 text-xs text-slate-500">
            No {title.toLowerCase()} tasks.
          </div>
        )}
      </div>
    </div>
  );
}

function CompletedBoard({ tasks, onToggleComplete, onDeleteTask, onMoveTask, onClearCompleted }) {
  return (
    <div className="rounded-2xl border border-emerald-300/20 bg-emerald-300/[0.06] p-3">
      <div className="mb-2 flex items-center justify-between">
        <div>
          <h3 className="text-sm font-black text-white">Completed</h3>
          <p className="mt-1 text-[11px] text-emerald-100/60">Finished across Study, Work, and Personal.</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span className="rounded-full bg-emerald-300/15 px-2 py-1 text-[10px] font-black text-emerald-100">
            {tasks.length}
          </span>
          <button
            type="button"
            onClick={onClearCompleted}
            disabled={!tasks.length}
            className="grid h-7 w-7 place-items-center rounded-full bg-emerald-300/15 text-emerald-100 transition hover:bg-emerald-300/30 disabled:cursor-not-allowed disabled:opacity-35"
            title="Clear completed tasks"
            aria-label="Clear completed tasks"
          >
            <RefreshIcon />
          </button>
        </div>
      </div>
      <div className="space-y-2">
        {tasks.length ? (
          tasks.slice(0, 5).map((task) => (
            <TaskRow
              key={task.id || `done-${task.title}`}
              task={task}
              onToggleComplete={onToggleComplete}
              onDelete={onDeleteTask}
              onMoveCategory={onMoveTask}
              compact
            />
          ))
        ) : (
          <div className="rounded-xl border border-dashed border-emerald-300/15 bg-slate-950/25 p-3 text-xs text-emerald-100/55">
            Complete a task and it will land here.
          </div>
        )}
      </div>
    </div>
  );
}

function EventRow({ event, onDelete }) {
  return (
    <div className="flex items-center gap-3 rounded-2xl border border-white/10 bg-white/[0.05] p-3">
      <div className="grid h-10 w-10 place-items-center rounded-2xl bg-cyan-300/15 text-xs font-black text-cyan-100">CAL</div>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-bold text-white">{event.title}</p>
        <p className="mt-1 text-xs text-slate-400">
          {getDisplayTime(event.start_time || event.start)} to {getDisplayTime(event.end_time || event.end)}
        </p>
      </div>
      {onDelete ? (
        <button
          type="button"
          onClick={() => onDelete(event)}
          className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-rose-500/15 text-rose-100 transition hover:bg-rose-500/35"
          title="Delete calendar event"
          aria-label={`Delete ${event.title}`}
        >
          <TrashIcon />
        </button>
      ) : null}
    </div>
  );
}

function isSameCalendarDate(left, right) {
  if (!left || !right) return false;
  return left.getFullYear() === right.getFullYear()
    && left.getMonth() === right.getMonth()
    && left.getDate() === right.getDate();
}

function getDateFromNaturalValue(value) {
  if (!value) return null;
  const parsed = new Date(value);
  if (!Number.isNaN(parsed.getTime())) return parsed;
  const lower = String(value).toLowerCase();
  const today = new Date();
  if (lower.includes('today')) return new Date(today.getFullYear(), today.getMonth(), today.getDate());
  if (lower.includes('tomorrow')) return new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);
  return null;
}

function itemMatchesDate(item, selectedDate, value) {
  const parsed = getDateFromNaturalValue(value);
  if (parsed) return isSameCalendarDate(parsed, selectedDate);
  const dayMatch = String(value || '').match(/\b(\d{1,2})\b/);
  return dayMatch ? Number(dayMatch[1]) === selectedDate.getDate() : false;
}

function getEventDay(event) {
  const value = event.start_time || event.start;
  if (!value) return null;
  const parsed = new Date(value);
  if (!Number.isNaN(parsed.getTime())) return parsed.getDate();
  const dayMatch = String(value).match(/\b(\d{1,2})\b/);
  return dayMatch ? Number(dayMatch[1]) : null;
}

function getTaskDay(task) {
  const value = task.deadline || task.due || task.time;
  if (!value) return null;
  const lower = String(value).toLowerCase();
  const today = new Date();
  if (lower.includes('today')) return today.getDate();
  if (lower.includes('tomorrow')) return new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1).getDate();
  const parsed = new Date(value);
  if (!Number.isNaN(parsed.getTime())) return parsed.getDate();
  const dayMatch = String(value).match(/\b(\d{1,2})\b/);
  return dayMatch ? Number(dayMatch[1]) : null;
}

function getEventMatchesDate(event, selectedDate) {
  return itemMatchesDate(event, selectedDate, event.start_time || event.start);
}

function getTaskMatchesDate(task, selectedDate) {
  return itemMatchesDate(task, selectedDate, task.deadline || task.due || task.time);
}

function normalizeTitle(value) {
  return String(value || '').trim().toLowerCase();
}

function getCalendarDateTimeValue(item) {
  return item.start_time || item.start || item.deadline || item.due || item.time || '';
}

function getCalendarTimestamp(item) {
  const parsed = new Date(getCalendarDateTimeValue(item));
  return Number.isNaN(parsed.getTime()) ? null : parsed.getTime();
}

function taskMatchesEvent(task, event) {
  if (!task || !event) return false;
  if (event.task_id && task.id && String(event.task_id) === String(task.id)) return true;
  if (normalizeTitle(task.title) !== normalizeTitle(event.title)) return false;
  const taskTime = getCalendarTimestamp(task);
  const eventTime = getCalendarTimestamp(event);
  return taskTime !== null && eventTime !== null && Math.abs(taskTime - eventTime) < 60 * 1000;
}

function getVisibleEventsForDate(events, selectedDate) {
  const seen = new Set();
  return events
    .filter((event) => getEventMatchesDate(event, selectedDate))
    .filter((event) => {
      const timestamp = getCalendarTimestamp(event);
      const key = `${normalizeTitle(event.title)}-${timestamp ?? getCalendarDateTimeValue(event)}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function getVisibleTasksForDate(tasks, events, selectedDate) {
  const dayEvents = getVisibleEventsForDate(events, selectedDate);
  return tasks
    .filter((task) => !isTaskComplete(task))
    .filter((task) => getTaskMatchesDate(task, selectedDate))
    .filter((task) => !dayEvents.some((event) => taskMatchesEvent(task, event)));
}

function getExplicitFocusSessions(events) {
  return events
    .filter((event) => (
      typeof event.id === 'number'
      || String(event.id || '').startsWith('agent-event-')
      || String(event.id || '').startsWith('local-event-')
    ))
    .filter((event) => !event.html_link)
    .map((event, index) => {
      const start = new Date(event.start_time || event.start);
      const end = new Date(event.end_time || event.end);
      const fallbackDuration = Number.parseInt(event.end_time || event.end || '', 10);
      const duration = !Number.isNaN(start.getTime()) && !Number.isNaN(end.getTime())
        ? Math.max(5, Math.round((end.getTime() - start.getTime()) / 60000))
        : Math.max(5, fallbackDuration || 25);
      return {
        id: `focus-event-${event.id || index}`,
        eventId: event.id,
        title: event.title,
        duration,
        startLabel: !Number.isNaN(start.getTime())
          ? `Starts ${start.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}`
          : 'Manual focus block',
      };
    });
}

function getTimeSortValue(item) {
  const value = item.start_time || item.start || item.deadline || item.due || item.time || '';
  const parsed = new Date(value);
  if (!Number.isNaN(parsed.getTime())) return parsed.getTime();
  const match = String(value).match(/(\d{1,2})(?::(\d{2}))?\s*(AM|PM)?/i);
  if (!match) return Number.MAX_SAFE_INTEGER;
  let hour = Number(match[1]);
  const minute = Number(match[2] || 0);
  const meridiem = match[3]?.toUpperCase();
  if (meridiem === 'PM' && hour < 12) hour += 12;
  if (meridiem === 'AM' && hour === 12) hour = 0;
  return hour * 60 + minute;
}

function getDisplayTime(value) {
  if (!value) return 'Anytime';
  const parsed = new Date(value);
  if (!Number.isNaN(parsed.getTime())) {
    return parsed.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }
  const match = String(value).match(/(\d{1,2})(?::(\d{2}))?\s*(AM|PM)?/i);
  if (!match) return String(value);
  let hour = Number(match[1]);
  const minute = Number(match[2] || 0);
  let meridiem = match[3]?.toUpperCase();
  if (!meridiem && hour <= 12) {
    return `${hour}:${String(minute).padStart(2, '0')}`;
  }
  if (hour > 12) {
    hour -= 12;
    meridiem = 'PM';
  }
  return `${hour}:${String(minute).padStart(2, '0')} ${meridiem}`;
}

function getFriendlyDateTime(value) {
  if (!value) return '';
  const parsed = new Date(value);
  if (!Number.isNaN(parsed.getTime())) {
    const today = new Date();
    const tomorrow = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);
    const day = parsed.toDateString() === today.toDateString()
      ? 'Today'
      : parsed.toDateString() === tomorrow.toDateString()
        ? 'Tomorrow'
        : parsed.toLocaleDateString([], { month: 'short', day: 'numeric' });
    return `${day} ${parsed.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
  }
  return String(value);
}

function getHourKey(item) {
  const value = item.start_time || item.start || item.deadline || item.due || item.time || '';
  const parsed = new Date(value);
  if (!Number.isNaN(parsed.getTime())) return parsed.getHours();
  const match = String(value).match(/(\d{1,2})(?::(\d{2}))?\s*(AM|PM)?/i);
  if (!match) return null;
  let hour = Number(match[1]);
  const meridiem = match[3]?.toUpperCase();
  if (meridiem === 'PM' && hour < 12) hour += 12;
  if (meridiem === 'AM' && hour === 12) hour = 0;
  if (!meridiem && hour >= 1 && hour <= 7) hour += 12;
  return hour;
}

function makeSlotDeadline(selectedDate, hour) {
  const scheduled = new Date(
    selectedDate.getFullYear(),
    selectedDate.getMonth(),
    selectedDate.getDate(),
    hour,
    0,
    0,
    0,
  );
  return scheduled.toISOString();
}

function CalendarBoard({ events, tasks, selectedDate, visibleMonth, onSelectDate, onChangeMonth, onToday }) {
  const today = new Date();
  const monthName = visibleMonth.toLocaleString('default', { month: 'long' });
  const year = visibleMonth.getFullYear();
  const firstDay = new Date(year, visibleMonth.getMonth(), 1);
  const daysInMonth = new Date(year, visibleMonth.getMonth() + 1, 0).getDate();
  const leading = (firstDay.getDay() + 6) % 7;
  const cells = [
    ...Array.from({ length: leading }, () => null),
    ...Array.from({ length: daysInMonth }, (_, index) => index + 1),
  ];

  return (
    <div className="rounded-3xl border border-white/10 bg-slate-950/45 p-3">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <p className="text-xs font-black uppercase tracking-[0.18em] text-slate-500">Month</p>
          <h3 className="text-base font-black text-white">{monthName} {year}</h3>
        </div>
        <div className="flex shrink-0 gap-1">
          <button
            type="button"
            onClick={() => onChangeMonth(-1)}
            className="rounded-full bg-white/10 px-3 py-1 text-xs font-black text-cyan-100 hover:bg-white/20"
          >
            Prev
          </button>
          <button
            type="button"
            onClick={onToday}
            className="rounded-full bg-cyan-300/15 px-3 py-1 text-xs font-black text-cyan-100 hover:bg-cyan-300/25"
          >
            Today
          </button>
          <button
            type="button"
            onClick={() => onChangeMonth(1)}
            className="rounded-full bg-white/10 px-3 py-1 text-xs font-black text-cyan-100 hover:bg-white/20"
          >
            Next
          </button>
        </div>
      </div>

      <div className="grid grid-cols-7 gap-1 text-center">
        {weekdayLabels.map((day) => (
          <div key={day} className="py-1 text-[10px] font-black uppercase tracking-wide text-slate-500">
            {day}
          </div>
        ))}
        {cells.map((day, index) => {
          const date = day ? new Date(year, visibleMonth.getMonth(), day) : null;
          const dayEvents = date ? getVisibleEventsForDate(events, date) : [];
          const dayTasks = date ? getVisibleTasksForDate(tasks, events, date) : [];
          const isToday = date ? isSameCalendarDate(date, today) : false;
          const isSelected = date ? isSameCalendarDate(date, selectedDate) : false;
          return (
            <button
              type="button"
              key={`${day || 'blank'}-${index}`}
              onClick={() => date && onSelectDate(date)}
              disabled={!day}
              className={`min-h-14 rounded-xl border p-1 text-left transition ${
                day
                  ? isSelected
                    ? 'border-cyan-200 bg-cyan-300/25 shadow-[0_0_24px_rgba(103,232,249,0.12)]'
                    : isToday
                      ? 'border-cyan-300/70 bg-cyan-300/15'
                      : 'border-white/8 bg-white/[0.035] hover:border-white/20 hover:bg-white/[0.07]'
                  : 'border-transparent'
              }`}
            >
              {day ? (
                <>
                  <p className={`text-[11px] font-black ${isSelected || isToday ? 'text-cyan-100' : 'text-slate-400'}`}>{day}</p>
                  <div className="mt-1 space-y-1">
                    {dayEvents.slice(0, 1).map((event) => (
                      <div key={event.id || `${event.title}-${day}`} className="truncate rounded bg-cyan-300/20 px-1 py-0.5 text-[9px] font-bold text-cyan-100">
                        {event.title}
                      </div>
                    ))}
                    {dayTasks.slice(0, 1).map((task) => (
                      <div key={task.id || `${task.title}-${day}`} className="truncate rounded bg-rose-300/20 px-1 py-0.5 text-[9px] font-bold text-rose-100">
                        {task.title}
                      </div>
                    ))}
                  </div>
                </>
              ) : null}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function DayCalendarView({ selectedDate, events, tasks, onMoveTaskToSlot }) {
  const items = [
    ...getVisibleEventsForDate(events, selectedDate)
      .map((event) => ({ ...event, itemType: 'Event' })),
    ...getVisibleTasksForDate(tasks, events, selectedDate)
      .map((task) => ({ ...task, itemType: 'Task', start_time: task.deadline || task.due || task.time })),
  ].sort((a, b) => getTimeSortValue(a) - getTimeSortValue(b));
  const hours = Array.from({ length: 24 }, (_, index) => index);
  const selectedLabel = selectedDate.toLocaleDateString([], {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });

  return (
    <div className="rounded-3xl border border-white/10 bg-slate-950/45 p-3">
      <div className="mb-3 flex items-center justify-between">
        <div>
          <h3 className="text-sm font-black text-white">Day calendar</h3>
          <p className="mt-1 text-xs text-slate-500">Hourly schedule for the selected date.</p>
        </div>
        <span className="rounded-full bg-white/10 px-3 py-1 text-xs font-black text-slate-300">
          {selectedLabel}
        </span>
      </div>
      <div className="max-h-[520px] overflow-y-auto rounded-2xl border border-white/10 bg-white/[0.03]">
        {hours.map((hour) => {
          const slotItems = items.filter((item) => getHourKey(item) === hour);
          const labelHour = hour === 0 ? 12 : hour > 12 ? hour - 12 : hour;
          const labelSuffix = hour >= 12 ? 'PM' : 'AM';
          return (
            <div key={hour} className="grid min-h-20 grid-cols-[74px_1fr] border-b border-white/8 last:border-b-0">
              <div className="border-r border-white/8 px-3 py-3 text-right text-xs font-black text-slate-500">
                {labelHour}:00 {labelSuffix}
              </div>
              <div
                className="p-2 transition hover:bg-cyan-300/[0.04]"
                onDragOver={(event) => {
                  event.preventDefault();
                  event.dataTransfer.dropEffect = 'move';
                }}
                onDrop={(event) => {
                  event.preventDefault();
                  const taskId = event.dataTransfer.getData('text/plain');
                  if (taskId) onMoveTaskToSlot?.(taskId, selectedDate, hour);
                }}
              >
                {slotItems.length ? (
                  <div className="space-y-2">
                    {slotItems.map((item) => (
                      <div
                        key={`${item.itemType}-${item.id || item.title}`}
                        draggable={item.itemType === 'Task' && Boolean(item.id)}
                        onDragStart={(event) => {
                          if (item.itemType !== 'Task' || !item.id) return;
                          event.dataTransfer.setData('text/plain', item.id);
                          event.dataTransfer.effectAllowed = 'move';
                        }}
                        className={`rounded-2xl border px-3 py-2 ${
                          item.itemType === 'Task'
                            ? 'border-rose-300/20 bg-rose-300/12'
                            : 'border-cyan-300/20 bg-cyan-300/12'
                        }`}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <p className="text-sm font-black text-white">{item.title}</p>
                          <span className="rounded-full bg-white/10 px-2 py-1 text-[10px] font-black text-slate-300">
                            {item.itemType}
                          </span>
                        </div>
                        <p className="mt-1 text-xs text-slate-400">
                          {getDisplayTime(item.start_time || item.deadline)}
                          {item.end_time ? ` to ${getDisplayTime(item.end_time)}` : ''}
                          {item.category ? ` - ${item.category}` : ''}
                        </p>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="h-full rounded-xl border border-dashed border-white/5" />
                )}
              </div>
            </div>
          );
        })}
        {!items.length ? (
          <div className="p-4 text-sm text-slate-400">
            No tasks or events for this date.
          </div>
        ) : null}
      </div>
    </div>
  );
}

function ReminderRow({ reminder, onDelete }) {
  const [selected, setSelected] = useState(false);
  return (
    <div
      onClick={() => setSelected((current) => !current)}
      className="relative rounded-2xl border border-cyan-300/20 bg-cyan-300/10 p-3 transition hover:border-cyan-200/40"
    >
      {selected ? (
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onDelete(reminder);
          }}
          className="absolute left-2 top-2 grid h-7 w-7 place-items-center rounded-full bg-rose-500/20 text-rose-200 transition hover:bg-rose-500/40"
          title="Delete reminder"
          aria-label={`Delete ${reminder.title}`}
        >
          <TrashIcon />
        </button>
      ) : null}
      <div className={selected ? 'pl-8' : ''}>
        <p className="text-sm font-bold text-cyan-50">{reminder.title}</p>
        <p className="mt-1 text-xs text-cyan-100/70">
          {getFriendlyDateTime(reminder.time || reminder.due_at || reminder.due) || 'No time set'}
        </p>
      </div>
    </div>
  );
}

function ReminderComposer({ onAdd }) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [time, setTime] = useState('');

  const submitReminder = () => {
    const cleanTitle = title.trim();
    if (!cleanTitle) return;
    onAdd(cleanTitle, time.trim());
    setTitle('');
    setTime('');
    setOpen(false);
  };

  return (
    <div className="mb-3">
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        className="rounded-full bg-cyan-300 px-3 py-2 text-xs font-black text-slate-950"
      >
        {open ? 'Cancel' : 'Add reminder'}
      </button>
      {open ? (
        <div className="mt-3 grid gap-2 rounded-2xl border border-cyan-300/20 bg-slate-950/35 p-3 sm:grid-cols-[1fr_0.7fr_auto]">
          <input
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="Reminder title"
            className="min-w-0 rounded-xl border border-white/10 bg-white/[0.05] px-3 py-2 text-sm text-white outline-none placeholder:text-slate-500"
          />
          <input
            value={time}
            onChange={(event) => setTime(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') submitReminder();
            }}
            placeholder="Tomorrow 7 PM"
            className="min-w-0 rounded-xl border border-white/10 bg-white/[0.05] px-3 py-2 text-sm text-white outline-none placeholder:text-slate-500"
          />
          <button
            type="button"
            onClick={submitReminder}
            disabled={!title.trim()}
            className="rounded-xl bg-cyan-300 px-3 py-2 text-xs font-black text-slate-950 disabled:opacity-40"
          >
            Add
          </button>
        </div>
      ) : null}
    </div>
  );
}

function ChatPanel({
  messages,
  isThinking,
  reminderResult,
  onExecuteAction,
  executedTools,
  dismissedTools,
  onDismissAction,
  onRefreshChat,
  agentStatus,
}) {
  const endRef = useRef(null);
  const reminderProposal = reminderResult?.suggested_reminders?.[0];
  const showReminderProposal = reminderProposal
    && !executedTools.has('add_reminder')
    && !dismissedTools.has('add_reminder');

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [messages, isThinking]);

  return (
    <section className="rounded-3xl border border-white/10 bg-white/[0.05] p-4">
      <div className="mb-3 flex items-center justify-between">
        <div>
          <p className="text-[10px] font-black uppercase tracking-[0.18em] text-cyan-200/60">Conversation</p>
          <h2 className="mt-1 font-black">Promptly Chat</h2>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onRefreshChat}
            disabled={isThinking}
            className="flex h-8 items-center gap-1.5 rounded-full bg-white/10 px-3 text-xs font-black text-slate-300 transition hover:bg-white/20 hover:text-white disabled:opacity-40"
            title="Clear chat"
            aria-label="Clear chat"
          >
            <RefreshIcon />
            Clear
          </button>
          <span className="rounded-full bg-cyan-300/10 px-3 py-1 text-xs font-black text-cyan-100">
            voice + text
          </span>
        </div>
      </div>
      <div className="max-h-80 space-y-3 overflow-y-auto rounded-3xl border border-white/8 bg-slate-950/50 p-4">
        {messages.map((chatMessage) => (
          <div
            key={chatMessage.id}
            className={`flex ${chatMessage.role === 'user' ? 'justify-end' : 'justify-start'}`}
          >
            <div
              className={`max-w-[86%] rounded-2xl px-4 py-3 text-sm leading-6 ${
                chatMessage.role === 'user'
                  ? 'rounded-br-md bg-cyan-300 text-slate-950'
                  : 'rounded-bl-md border border-white/10 bg-white/[0.07] text-slate-200'
              }`}
            >
              <p className="whitespace-pre-line">{chatMessage.content}</p>
              {chatMessage.confirmation ? (
                <p className="mt-2 rounded-xl bg-emerald-300/12 px-3 py-2 text-xs font-black text-emerald-100">
                  {chatMessage.confirmation}
                </p>
              ) : null}
              {chatMessage.role === 'assistant' && chatMessage.modelSource ? (
                <div className="mt-2">
                  <p className="text-[10px] font-black uppercase tracking-[0.16em] opacity-45">
                    {chatMessage.modelSource === 'mistral_api'
                      ? 'Mistral API'
                      : chatMessage.modelSource === 'mistral'
                        ? 'Local Mistral'
                        : 'Fallback'}
                  </p>
                  {chatMessage.modelError ? (
                    <p className="mt-1 text-xs font-semibold text-rose-200/75">
                      {chatMessage.modelError}
                    </p>
                  ) : null}
                </div>
              ) : null}
            </div>
          </div>
        ))}
        {isThinking ? (
          <div className="flex justify-start">
            <div className="rounded-2xl rounded-bl-md border border-cyan-300/15 bg-cyan-300/[0.07] px-4 py-3 text-sm text-cyan-100">
              Understanding your request...
            </div>
          </div>
        ) : null}
        <div ref={endRef} />
      </div>
      {showReminderProposal ? (
        <div className="mt-3 rounded-2xl border border-cyan-300/25 bg-cyan-300/[0.08] p-4 shadow-xl shadow-slate-950/20">
          <p className="text-[10px] font-black uppercase tracking-[0.18em] text-cyan-100/60">Add a reminder?</p>
          <p className="mt-2 text-sm font-black text-white">{reminderProposal.title}</p>
          <p className="mt-1 text-xs text-cyan-100/70">{reminderProposal.time || 'Time not set'}</p>
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              onClick={() => onExecuteAction({ label: 'Add reminder', tool: 'add_reminder' })}
              className="rounded-full bg-cyan-300 px-3 py-2 text-xs font-black text-slate-950"
            >
              Add reminder
            </button>
            <button
              type="button"
              onClick={() => onDismissAction('add_reminder')}
              className="rounded-full bg-white/10 px-3 py-2 text-xs font-black text-slate-300 hover:bg-white/20"
            >
              Not now
            </button>
          </div>
        </div>
      ) : null}
      {reminderResult?.actions?.length || reminderResult?.suggested_reminders?.length ? (
        <div className="mt-3 flex flex-wrap gap-2">
          {(reminderResult.actions || []).map((action) => {
            const executed = executedTools.has(action.tool);
            if (action.tool === 'add_reminder') return null;
            return (
              <button
                key={`${action.tool}-${action.label}`}
                type="button"
                onClick={() => onExecuteAction(action)}
                disabled={executed}
                className="rounded-full bg-white/10 px-3 py-2 text-xs font-black text-white transition hover:bg-white/20 disabled:cursor-default disabled:bg-emerald-300/10 disabled:text-emerald-100"
              >
                {executed ? `${action.label} done` : action.label}
              </button>
            );
          })}
        </div>
      ) : null}
    </section>
  );
}

function RecommendationPanel({ liveRecommendations, agentDigest }) {
  const topTask = liveRecommendations.nextAction;
  const overdueCount = liveRecommendations.stats.overdue;
  const dueSoonCount = liveRecommendations.stats.dueSoon;
  const agentMessage = agentDigest?.agent_message;
  const scoreTone = liveRecommendations.efficiencyScore >= 75
    ? 'text-emerald-100 bg-emerald-300/12'
    : liveRecommendations.efficiencyScore >= 50
      ? 'text-amber-100 bg-amber-300/12'
      : 'text-rose-100 bg-rose-300/12';
  return (
    <section className="rounded-3xl border border-violet-300/15 bg-violet-300/[0.05] p-4">
      <div className="mb-3 flex items-center justify-between">
        <div>
          <p className="text-[10px] font-black uppercase tracking-[0.18em] text-violet-200/60">Proactive intelligence</p>
          <h2 className="mt-1 font-black">AI Recommendations</h2>
        </div>
        <span className={`rounded-full px-3 py-1 text-xs font-black ${scoreTone}`}>
          {liveRecommendations.efficiencyScore}% efficient
        </span>
      </div>
      <div className="rounded-3xl border border-white/8 bg-slate-950/45 p-4">
        {agentMessage ? (
          <div className="mb-3 rounded-2xl border border-violet-200/10 bg-violet-300/10 p-3">
            <p className="text-[10px] font-black uppercase tracking-[0.16em] text-violet-200/60">Agent digest</p>
            <p className="mt-1 text-sm font-bold leading-6 text-violet-50">{agentMessage}</p>
          </div>
        ) : null}
        {topTask ? (
          <>
            <p className="text-xs font-black uppercase tracking-[0.16em] text-violet-200/65">Best next action</p>
            <h3 className="mt-2 text-base font-black text-white">{topTask.title}</h3>
            <p className="mt-2 text-sm leading-6 text-slate-300">{topTask.reason}</p>
            <div className="mt-3 rounded-2xl border border-cyan-200/10 bg-cyan-300/[0.06] p-3">
              <p className="text-[10px] font-black uppercase tracking-[0.16em] text-cyan-100/60">Focus suggestion</p>
              <p className="mt-1 text-sm font-bold leading-5 text-cyan-50">{liveRecommendations.focusSuggestion}</p>
            </div>
            <div className="mt-4 grid grid-cols-3 gap-2 text-center">
              <div className="rounded-2xl bg-white/[0.05] p-3">
                <p className="text-lg font-black text-white">{overdueCount}</p>
                <p className="text-[10px] text-slate-500">overdue</p>
              </div>
              <div className="rounded-2xl bg-white/[0.05] p-3">
                <p className="text-lg font-black text-white">{dueSoonCount}</p>
                <p className="text-[10px] text-slate-500">due 24h</p>
              </div>
              <div className="rounded-2xl bg-white/[0.05] p-3">
                <p className="text-lg font-black text-white">{liveRecommendations.stats.conflicts}</p>
                <p className="text-[10px] text-slate-500">conflicts</p>
              </div>
            </div>
            <div className="mt-3 space-y-2">
              {liveRecommendations.insightItems.map((item) => (
                <div key={`${item.title}-${item.detail}`} className="rounded-2xl border border-white/8 bg-white/[0.04] p-3">
                  <p className="text-xs font-black text-white">{item.title}</p>
                  <p className="mt-1 text-xs leading-5 text-slate-400">{item.detail}</p>
                </div>
              ))}
            </div>
          </>
        ) : (
          <div className="py-4 text-sm leading-6 text-slate-400">
            Add a task with a deadline and Promptly will recommend the best next action.
          </div>
        )}
      </div>
    </section>
  );
}

function ExpandedMode({ dashboard, tasks, setTasks, canUndo, canRedo, onUndo, onRedo, reminders, setReminders, events, setEvents, habits, setHabits, calendarStatus, agentStatus, authUser, onGoogleLogin, onLogout, onHide, refreshAgentStatus, refreshCalendar, refreshBackendState, onCollapse }) {
  const [input, setInput] = useState('');
  const [category, setCategory] = useState('Study');
  const [isThinking, setIsThinking] = useState(false);
  const [agentResult, setAgentResult] = useState(null);
  const [chatMessages, setChatMessages] = useState(getInitialChatMessages);
  const [selectedCalendarDate, setSelectedCalendarDate] = useState(() => new Date());
  const [visibleCalendarMonth, setVisibleCalendarMonth] = useState(() => new Date());
  const [calendarView, setCalendarView] = useState('month');
  const [activeFocus, setActiveFocus] = useState(null);
  const [showAllTasks, setShowAllTasks] = useState(false);
  const [showManualTaskComposer, setShowManualTaskComposer] = useState(false);
  const [executedTools, setExecutedTools] = useState(new Set());
  const [dismissedTools, setDismissedTools] = useState(new Set());
  const [agentDigest, setAgentDigest] = useState(null);
  const lastTaskIdRef = useRef(null);
  const speech = useSpeechInput(setInput);

  useEffect(() => {
    const handleHistoryShortcut = (event) => {
      const modifier = event.metaKey || event.ctrlKey;
      if (!modifier) return;
      const target = event.target;
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return;
      if (event.key.toLowerCase() === 'z') {
        event.preventDefault();
        if (event.shiftKey) onRedo();
        else onUndo();
      } else if (event.key.toLowerCase() === 'y') {
        event.preventDefault();
        onRedo();
      }
    };
    window.addEventListener('keydown', handleHistoryShortcut);
    return () => window.removeEventListener('keydown', handleHistoryShortcut);
  }, [onRedo, onUndo]);

  useEffect(() => {
    window.localStorage.setItem('promptly-chat', JSON.stringify(chatMessages));
  }, [chatMessages]);

  useEffect(() => {
    let cancelled = false;
    const loadDigest = async () => {
      if (!hasBackendSession()) {
        setAgentDigest(null);
        return;
      }
      try {
        const digest = await getAgentDigest();
        if (!cancelled) setAgentDigest(digest);
      } catch {
        if (!cancelled) setAgentDigest(null);
      }
    };
    loadDigest();
    return () => {
      cancelled = true;
    };
  }, [tasks, events]);

  useEffect(() => {
    const mistralHealthy = ['mistral', 'mistral_api'].includes(agentStatus?.mode)
      && agentStatus?.model_ready
      && !agentStatus?.last_error;
    if (!mistralHealthy) return;
    setChatMessages((prev) => {
      const next = prev.filter((message) => {
        if (message.role !== 'assistant') return true;
        const staleFallback = message.modelSource === 'fallback';
        const stale401 = /Mistral rejected the API key \(401\)|API key is invalid or missing \(401\)/i.test(
          `${message.content || ''} ${message.modelError || ''}`,
        );
        return !staleFallback && !stale401;
      });
      return next.length === prev.length ? prev : next;
    });
  }, [agentStatus]);

  const tasksFromAgentResult = (result) => {
    if (!result?.suggested_tasks?.length) return [];
    return result.suggested_tasks
      .filter((task) => !junkTaskTitles.has(String(task.title || '').trim().toLowerCase()))
      .map((task, index) => {
      const nextTask = {
      id: `agent-task-${Date.now()}-${index}`,
      title: task.title,
      category: task.category || category,
      priority: task.priority || 'medium',
      deadline: task.deadline || task.time || 'Needs date',
      estimate: `${task.estimated_time || 45}m`,
      estimated_time: task.estimated_time || 45,
      status: 'todo',
      };
      if ((task.estimated_time || 45) >= 90 || /project|assignment|exam|hackathon|build/i.test(task.title || '')) {
        nextTask.subtasks = getTaskProgress(nextTask).subtasks;
      }
      return nextTask;
      });
  };

  const eventsFromAgentResult = (result) => {
    if (!result?.schedule_blocks?.length) return [];
    return result.schedule_blocks.map((block, index) => ({
      id: `agent-event-${Date.now()}-${index}`,
      title: block.title,
      start_time: block.start_hint,
      end_time: `${block.duration_minutes || 45} min focus`,
    }));
  };

  const remindersFromAgentResult = (result) => {
    if (!result?.suggested_reminders?.length) return [];
    return result.suggested_reminders.map((reminder, index) => ({
      id: `agent-reminder-${Date.now()}-${index}`,
      title: reminder.title || reminder.text,
      time: reminder.time || reminder.due_at || reminder.due || reminder.when,
    })).filter((reminder) => reminder.title);
  };

  const autoApplyAgentResult = (result, sourceMessage = '') => {
    const uncertainFallback = Boolean(result?.model_error)
      && !['mistral', 'mistral_api'].includes(result?.model_source);
    if (
      result?.needs_confirmation
      || uncertainFallback
    ) {
      return '';
    }
    const newTasks = tasksFromAgentResult(result);
    const newEvents = eventsFromAgentResult(result);
    const newReminders = remindersFromAgentResult(result);
    if (result?.intent === 'create_reminder' && newReminders.length) {
      setReminders((prev) => prependUniqueByTitle(prev, newReminders));
      return `Added ${newReminders.length} reminder${newReminders.length === 1 ? '' : 's'}.`;
    }
    const isContextualUpdate = result?.intent === 'update_task'
      && /\b(that|it|this)\b/i.test(sourceMessage)
      && newTasks.length > 0;
    if (isContextualUpdate) {
      const suggestedTask = newTasks[0];
      const suggestedTitle = String(suggestedTask.title || '').trim().toLowerCase();
      const targetTask = tasks.find(
        (task) => String(task.title || '').trim().toLowerCase() === suggestedTitle,
      ) || tasks.find((task) => (
        !isTaskComplete(task)
        && !/^(that|it|this)$/i.test(String(task.title || '').trim())
      ));
      if (targetTask) {
        setTasks((prev) => prev
          .filter((task) => !/^(that|it|this)$/i.test(String(task.title || '').trim()))
          .map((task) => (
            task.id === targetTask.id
              ? {
                  ...task,
                  deadline: suggestedTask.deadline,
                  estimate: suggestedTask.estimate,
                  estimated_time: suggestedTask.estimated_time,
                }
              : task
          )));
        setEvents((prev) => prev.filter(
          (event) => String(event.title || '').trim().toLowerCase() !== 'that',
        ));
        return `Updated ${targetTask.title} on your calendar instead of creating another task.`;
      }
    }
    if (result?.intent !== 'create_task') return '';
    const newTaskTitles = new Set(
      newTasks.map((task) => String(task.title || '').trim().toLowerCase()),
    );
    const calendarOnlyEvents = newEvents.filter(
      (event) => !newTaskTitles.has(String(event.title || '').trim().toLowerCase()),
    );
    if (newTasks.length) setTasks((prev) => prependUniqueByTitle(prev, newTasks));
    if (newTasks[0]?.id) lastTaskIdRef.current = newTasks[0].id;
    if (newTasks.length || calendarOnlyEvents.length) {
      setEvents((prev) => {
        const withoutTaskDuplicates = prev.filter((event) => {
          const title = String(event.title || '').trim().toLowerCase();
          return !String(event.id || '').startsWith('agent-event-') || !newTaskTitles.has(title);
        });
        return prependUniqueByTitle(withoutTaskDuplicates, calendarOnlyEvents);
      });
    }
    if (newTasks.length || calendarOnlyEvents.length) {
      const notice = newTasks.length
        ? `Added ${newTasks.length} task${newTasks.length === 1 ? '' : 's'} to your dashboard${newTasks.some((task) => task.deadline && task.deadline !== 'Needs date') ? ' and calendar' : ''}.`
        : `Added ${calendarOnlyEvents.length} focus session${calendarOnlyEvents.length === 1 ? '' : 's'} to your calendar.`;
      return notice;
    } else {
      return '';
    }
  };

  const handleTimeCorrection = (message) => {
    const intent = getCorrectionIntent(message);
    if (!intent) return false;

    const targetTask = tasks.find((task) => task.id === lastTaskIdRef.current)
      || [...tasks]
        .filter((task) => !isTaskComplete(task))
        .sort((left, right) => Number(right.id || 0) - Number(left.id || 0))[0];
    if (!targetTask) return false;

    const nextDeadline = applyCorrectionToDeadline(targetTask.deadline, intent);
    setTasks((prev) => prev
      .filter((task) => !getCorrectionIntent(task.title || ''))
      .map((task) => (
        task.id === targetTask.id ? { ...task, deadline: nextDeadline } : task
      )));
    setEvents((prev) => prev.map((event) => (
      event.title === targetTask.title ? { ...event, start_time: nextDeadline } : event
    )));
    const correctionResult = {
      title: 'Time updated',
      badge: 'Promptly',
      model_source: 'local',
      reasoning: 'Detected this as a correction to the latest scheduled task.',
      content: `Updated ${targetTask.title} to ${getFriendlyDateTime(nextDeadline)}.`,
      followUp: 'You can also drag the task directly onto a calendar time slot.',
      agent_steps: [
        'Detected a correction instead of a new task.',
        'Found the latest scheduled task.',
        'Updated its time without creating a duplicate task.',
      ],
      actions: [{ label: 'Time corrected', tool: 'time_corrected' }],
      suggested_tasks: [],
      suggested_reminders: [],
      schedule_blocks: [],
    };
    setAgentResult(correctionResult);
    setChatMessages((prev) => [...prev, {
      id: `assistant-${Date.now()}`,
      role: 'assistant',
      content: correctionResult.content,
      confirmation: `Updated on your calendar: ${getFriendlyDateTime(nextDeadline)}.`,
    }]);
    return true;
  };

  const handlePendingConfirmationReply = async (message) => {
    if (!agentResult?.needs_confirmation || !agentResult?.actions?.length) return false;
    if (isNegativeReply(message)) {
      setAgentResult(null);
      setExecutedTools(new Set());
      setDismissedTools(new Set());
      setChatMessages((prev) => [...prev, {
        id: `confirm-cancel-${Date.now()}`,
        role: 'assistant',
        content: 'Okay, I left it unchanged.',
      }]);
      return true;
    }
    if (!isAffirmativeReply(message)) return false;

    const action = agentResult.actions?.[0]
      || (agentResult.suggested_tasks?.length ? { label: 'Add task', tool: 'task_added' } : null);
    if (!action) return false;
    await executeAgentAction(action);
    return true;
  };

  const submit = async (message = input) => {
    const clean = message.trim();
    if (!clean || isThinking) return;
    setInput('');
    setChatMessages((prev) => [...prev, {
      id: `user-${Date.now()}`,
      role: 'user',
      content: clean,
    }]);
    if (await handlePendingConfirmationReply(clean)) return;
    if (handleTimeCorrection(clean)) return;
    setIsThinking(true);
    try {
      const result = await runAgent(clean, category.toLowerCase(), chatMessages, {
        tasks,
        events,
        reminders,
      });
      await refreshAgentStatus();
      setAgentResult(result);
      setDismissedTools(new Set());
      setExecutedTools(new Set(
        result.created_tasks?.length || result.created_events?.length || result.created_reminders?.length
          ? (result.actions || []).map((action) => action.tool)
          : [],
      ));
      let confirmation = '';
      if (hasBackendSession() && (result.created_tasks?.length || result.created_events?.length || result.created_reminders?.length)) {
        if (result.created_tasks?.[0]?.id) lastTaskIdRef.current = result.created_tasks[0].id;
        await refreshBackendState();
        await refreshCalendar();
        if (result.created_reminders?.length && !(result.created_tasks?.length || result.created_events?.length)) {
          confirmation = `Saved ${result.created_reminders.length} reminder${result.created_reminders.length === 1 ? '' : 's'}.`;
        } else {
          confirmation = `Saved ${result.created_tasks?.length || 0} task${result.created_tasks?.length === 1 ? '' : 's'} and ${result.created_events?.length || 0} calendar event${result.created_events?.length === 1 ? '' : 's'}.`;
        }
      } else {
        confirmation = autoApplyAgentResult(result, clean);
        if (confirmation && result.intent === 'create_reminder') {
          setExecutedTools((prev) => new Set([...prev, 'add_reminder']));
        }
      }
      setChatMessages((prev) => [...prev, {
        id: `assistant-${Date.now()}`,
        role: 'assistant',
        content: result.content || result.followUp || 'Done.',
        confirmation,
        modelSource: result.model_source || 'fallback',
        modelError: result.model_error || '',
      }]);
    } catch {
      await refreshAgentStatus();
      setChatMessages((prev) => [...prev, {
        id: `assistant-${Date.now()}`,
        role: 'assistant',
        content: 'I could not reach the AI service. Your existing tasks and calendar are unchanged.',
      }]);
    } finally {
      setIsThinking(false);
    }
  };

  const addSuggestedTasks = async () => {
    const newTasks = tasksFromAgentResult(agentResult);
    if (!newTasks.length) return 0;
    if (hasBackendSession()) {
      for (const task of newTasks) {
        const deadline = parseActionDateTime(task.deadline);
        await createBackendTask({
          title: task.title,
          description: task.description || 'Created from a confirmed Promptly action.',
          deadline: deadline?.toISOString() || null,
          category: String(task.category || category).toLowerCase(),
          priority: task.priority || 'medium',
          estimated_time: task.estimated_time || 45,
          status: 'todo',
        });
      }
      await refreshBackendState();
      return newTasks.length;
    }
    lastTaskIdRef.current = newTasks[0].id;
    const newTaskTitles = new Set(
      newTasks.map((task) => String(task.title || '').trim().toLowerCase()),
    );
    setTasks((prev) => prependUniqueByTitle(prev, newTasks));
    setEvents((prev) => prev.filter((event) => {
      const title = String(event.title || '').trim().toLowerCase();
      return !String(event.id || '').startsWith('agent-event-') || !newTaskTitles.has(title);
    }));
    return newTasks.length;
  };

  const addManualTask = async (task) => {
    const payload = {
      title: task.title,
      description: 'Created manually in Promptly.',
      deadline: task.deadline,
      category: String(task.category || 'Personal').toLowerCase(),
      priority: 'medium',
      estimated_time: 45,
      status: 'todo',
    };
    if (hasBackendSession()) {
      await createBackendTask(payload);
      await refreshBackendState();
      setShowManualTaskComposer(false);
      return;
    }
    setTasks((prev) => prependUniqueByTitle(prev, [{
      ...payload,
      id: `manual-task-${Date.now()}`,
      category: task.category,
      estimate: '45m',
    }]));
    setShowManualTaskComposer(false);
  };

  const addFocusSessions = async () => {
    const newEvents = eventsFromAgentResult(agentResult);
    if (!newEvents.length) return 0;
    if (hasBackendSession()) {
      for (const event of newEvents) {
        const start = parseActionDateTime(event.start_time);
        if (!start) continue;
        const duration = Number.parseInt(event.end_time, 10) || 45;
        const end = new Date(start.getTime() + duration * 60 * 1000);
        await createBackendCalendarEvent({
          title: event.title,
          start_time: start.toISOString(),
          end_time: end.toISOString(),
        });
      }
      await refreshBackendState();
      await refreshCalendar();
      return newEvents.length;
    }
    const taskTitles = new Set(
      tasks.map((task) => String(task.title || '').trim().toLowerCase()),
    );
    const calendarOnlyEvents = newEvents.filter(
      (event) => !taskTitles.has(String(event.title || '').trim().toLowerCase()),
    );
    if (calendarOnlyEvents.length) {
      setEvents((prev) => prependUniqueByTitle(prev, calendarOnlyEvents));
    }
    return calendarOnlyEvents.length;
  };

  const addManualFocusSession = async ({ title, start, duration }) => {
    const end = new Date(start.getTime() + duration * 60 * 1000);
    if (hasBackendSession()) {
      await createBackendCalendarEvent({
        title,
        start_time: start.toISOString(),
        end_time: end.toISOString(),
      });
      await refreshBackendState();
      await refreshCalendar();
      return;
    }
    setEvents((prev) => prependUniqueByTitle(prev, [{
      id: `local-event-${Date.now()}`,
      title,
      start_time: start.toISOString(),
      end_time: end.toISOString(),
    }]));
  };

  const deleteFocusSession = async (session) => {
    if (activeFocus?.id === session.id) setActiveFocus(null);
    if (hasBackendSession() && typeof session.eventId === 'number') {
      await deleteBackendCalendarEvent(session.eventId);
      await refreshBackendState();
      await refreshCalendar();
      return;
    }
    setEvents((prev) => prev.filter((event) => String(event.id) !== String(session.eventId)));
  };

  const deleteCalendarEvent = async (event) => {
    setEvents((prev) => prev.filter((item) => String(item.id) !== String(event.id)));
    if (typeof event.id === 'number' && hasBackendSession()) {
      await deleteBackendCalendarEvent(event.id);
      await refreshBackendState();
      await refreshCalendar();
      return;
    }
    if (event.html_link && event.id) {
      await deleteGoogleCalendarEvent(event.id);
      await refreshCalendar();
    }
  };

  const moveTaskToCategory = async (taskId, nextCategory) => {
    const targetTask = tasks.find((task) => String(task.id) === String(taskId));
    setTasks((prev) => prev.map((task) => (
      String(task.id) === String(taskId) ? { ...task, category: nextCategory } : task
    )));
    if (hasBackendSession() && typeof targetTask?.id === 'number') {
      await updateBackendTask(targetTask.id, { category: nextCategory.toLowerCase() });
      await refreshBackendState();
    }
  };

  const moveTaskToCalendarSlot = (taskId, date, hour) => {
    const nextDeadline = makeSlotDeadline(date, hour);
    const targetTask = tasks.find((task) => task.id === taskId);
    setTasks((prev) => prev.map((task) => {
      if (task.id !== taskId) return task;
      return { ...task, deadline: nextDeadline };
    }));
    setEvents((prev) => prev.map((event) => (
      event.title === targetTask?.title ? { ...event, start_time: nextDeadline } : event
    )));
  };

  const addSuggestedReminders = async () => {
    if (!agentResult?.suggested_reminders?.length) return 0;
    const newReminders = remindersFromAgentResult(agentResult);
    if (hasBackendSession()) {
      for (const reminder of newReminders) {
        await createBackendReminder({
          title: reminder.title,
          due_at: parseActionDateTime(reminder.time)?.toISOString() || null,
          status: 'pending',
        });
      }
      await refreshBackendState();
      return newReminders.length;
    }
    setReminders((prev) => prependUniqueByTitle(prev, newReminders));
    return newReminders.length;
  };

  const addManualReminder = async (title, time) => {
    if (hasBackendSession()) {
      await createBackendReminder({
        title,
        due_at: parseActionDateTime(time)?.toISOString() || null,
        status: 'pending',
      });
      await refreshBackendState();
      return;
    }
    setReminders((prev) => prependUniqueByTitle(prev, [{
      id: `manual-reminder-${Date.now()}`,
      title,
      time: time || 'No time set',
    }]));
  };

  const addTaskReminder = (task) => {
    addManualReminder(task.title, getFriendlyDateTime(task.deadline) || 'No time set');
  };

  const rescheduleTask = (taskId, deadline) => {
    setTasks((prev) => prev.map((task) => (
      task.id === taskId ? { ...task, deadline } : task
    )));
  };

  const blockFreeSlot = async (slot) => {
    const event = {
      title: slot.task.title,
      start_time: slot.start.toISOString(),
      end_time: slot.end.toISOString(),
    };
    if (hasBackendSession()) {
      await createBackendCalendarEvent(event);
      await refreshBackendState();
      await refreshCalendar();
    } else {
      setEvents((prev) => prependUniqueByTitle(prev, [{
        id: `local-event-${Date.now()}`,
        ...event,
      }]));
    }
    setChatMessages((prev) => [...prev, {
      id: `slot-${Date.now()}`,
      role: 'assistant',
      content: `Blocked ${slot.duration} minutes for ${slot.task.title}.`,
      confirmation: `Scheduled for ${slot.start.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}.`,
    }]);
  };

  const recoverMissedTask = async (task, choice) => {
    const now = new Date();
    const start = choice === 'tonight'
      ? new Date(now.getFullYear(), now.getMonth(), now.getDate(), 19, 0, 0, 0)
      : new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 9, 0, 0, 0);
    if (start <= now) start.setDate(start.getDate() + 1);
    const duration = Math.min(90, Math.max(25, Number.parseInt(
      task.estimated_time || task.estimate || 45,
      10,
    ) || 45));
    const end = new Date(start.getTime() + duration * 60000);

    if (hasBackendSession() && typeof task.id === 'number') {
      await updateBackendTask(task.id, { deadline: start.toISOString() });
      await createBackendCalendarEvent({
        title: task.title,
        start_time: start.toISOString(),
        end_time: end.toISOString(),
      });
      await refreshBackendState();
      await refreshCalendar();
    } else {
      setTasks((prev) => prev.map((item) => (
        item.id === task.id ? { ...item, deadline: start.toISOString() } : item
      )));
      setEvents((prev) => prependUniqueByTitle(prev, [{
        id: `local-event-${Date.now()}`,
        title: task.title,
        start_time: start.toISOString(),
        end_time: end.toISOString(),
      }]));
    }
    setChatMessages((prev) => [...prev, {
      id: `recovery-${Date.now()}`,
      role: 'assistant',
      content: `Rescheduled ${task.title}.`,
      confirmation: `Recovery block: ${start.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}.`,
    }]);
  };

  const executeAgentAction = async (action) => {
    if (!action?.tool || executedTools.has(action.tool)) return;
    const taskTools = new Set(['create_tasks', 'create_milestones', 'task_added']);
    const calendarTools = new Set(['schedule_blocks', 'focus_session_added', 'schedule_time']);
    const reminderTools = new Set(['add_reminder', 'create_reminder', 'add_reminders']);

    if (taskTools.has(action.tool)) {
      await addSuggestedTasks();
    } else if (calendarTools.has(action.tool)) {
      await addFocusSessions();
    } else if (reminderTools.has(action.tool)) {
      await addSuggestedReminders();
    } else if (action.tool === 'delete_task') {
      const targetTitle = normalizeTitleForIdentity(agentResult?.delete_target);
      const targetTask = (
        targetTitle
          ? tasks.find((task) => normalizeTitleForIdentity(task.title) === targetTitle)
          : null
      ) || [...tasks].reverse().find((task) => !isTaskComplete(task));
      if (!targetTask) {
        setChatMessages((prev) => [...prev, {
          id: `delete-missing-${Date.now()}`,
          role: 'assistant',
          content: 'I could not find a matching task to delete.',
        }]);
        return;
      }
      await deleteTask(targetTask.id);
      setExecutedTools((prev) => new Set([...prev, action.tool]));
      setAgentResult(null);
      setChatMessages((prev) => [...prev, {
        id: `delete-${Date.now()}`,
        role: 'assistant',
        content: `Deleted ${targetTask.title}.`,
        confirmation: 'The confirmed task was removed.',
      }]);
      return;
    } else if (action.tool === 'time_correction') {
      return;
    } else {
      setChatMessages((prev) => [...prev, {
        id: `tool-error-${Date.now()}`,
        role: 'assistant',
        content: `The ${action.label} tool is not connected yet, so no data was changed.`,
      }]);
      return;
    }

    setExecutedTools((prev) => new Set([...prev, action.tool]));
    setChatMessages((prev) => [...prev, {
      id: `tool-${Date.now()}`,
      role: 'assistant',
      content: `${action.label} completed.`,
      confirmation: 'The tool executed directly. No extra chat request was sent.',
    }]);
  };

  const refreshChat = () => {
    window.localStorage.removeItem('promptly-chat');
    setChatMessages([{
      id: `welcome-${Date.now()}`,
      role: 'assistant',
      content: 'New conversation started. What would you like to get done?',
    }]);
    setAgentResult(null);
    setExecutedTools(new Set());
    setDismissedTools(new Set());
    setInput('');
  };

  const connectCalendar = async () => {
    try {
      const url = await getCalendarAuthUrl();
      const popup = window.open(url, '_blank', 'noopener,noreferrer');
      if (!popup) window.location.assign(url);
    } catch (error) {
      window.alert(error.message || 'Could not connect Google Calendar.');
    }
  };

  const openCalendarDay = (date) => {
    setSelectedCalendarDate(date);
    setVisibleCalendarMonth(new Date(date.getFullYear(), date.getMonth(), 1));
    setCalendarView('day');
  };

  const changeCalendarMonth = (offset) => {
    setVisibleCalendarMonth((current) => new Date(current.getFullYear(), current.getMonth() + offset, 1));
  };

  const jumpToToday = () => {
    const today = new Date();
    setSelectedCalendarDate(today);
    setVisibleCalendarMonth(new Date(today.getFullYear(), today.getMonth(), 1));
  };

  const toggleTaskComplete = (taskId) => {
    setTasks((prev) => prev.map((task) => (
      task.id === taskId
        ? { ...task, status: isTaskComplete(task) ? 'todo' : 'completed' }
        : task
    )));
  };

  const deleteTask = async (taskId) => {
    const task = tasks.find((item) => item.id === taskId);
    const targetTitle = normalizeTitleForIdentity(task?.title);
    setTasks((prev) => prev.filter((item) => (
      item.id !== taskId
      && (!targetTitle || normalizeTitleForIdentity(item.title) !== targetTitle)
    )));
    if (task?.title) {
      setEvents((prev) => prev.filter((event) => normalizeTitleForIdentity(event.title) !== targetTitle));
    }
    if (hasBackendSession()) {
      const matchingTasks = tasks.filter((item) => (
        typeof item.id === 'number'
        && (
          item.id === taskId
          || (targetTitle && normalizeTitleForIdentity(item.title) === targetTitle)
        )
      ));
      for (const matchingTask of matchingTasks) {
        await deleteBackendTask(matchingTask.id);
      }
      await refreshBackendState();
      await refreshCalendar();
    }
  };

  const clearCompletedTasks = async () => {
    const doneTasks = tasks.filter(isTaskComplete);
    if (!doneTasks.length) return;

    const doneTitles = new Set(
      doneTasks.map((task) => String(task.title || '').trim().toLowerCase()).filter(Boolean),
    );
    setTasks((prev) => prev.filter((task) => !isTaskComplete(task)));
    setEvents((prev) => prev.filter((event) => (
      !doneTitles.has(String(event.title || '').trim().toLowerCase())
    )));

    if (hasBackendSession()) {
      for (const task of doneTasks) {
        if (typeof task.id === 'number') {
          await deleteBackendTask(task.id);
        }
      }
      await refreshBackendState();
      await refreshCalendar();
    }
  };

  const deleteReminder = async (targetReminder) => {
    if (hasBackendSession() && typeof targetReminder.id === 'number') {
      await deleteBackendReminder(targetReminder.id);
      await refreshBackendState();
      return;
    }
    setReminders((prev) => prev.filter((reminder) => (
      targetReminder.id
        ? reminder.id !== targetReminder.id
        : reminder !== targetReminder
    )));
  };

  const toggleSubtask = (taskId, subtaskId) => {
    setTasks((prev) => prev.map((task) => {
      if (task.id !== taskId) return task;
      const progress = getTaskProgress(task);
      const subtasks = progress.subtasks.map((subtask) => (
        subtask.id === subtaskId ? { ...subtask, done: !subtask.done } : subtask
      ));
      const complete = subtasks.every((subtask) => subtask.done);
      return { ...task, subtasks, status: complete ? 'completed' : task.status };
    }));
  };

  const toggleHabit = (habitId) => {
    const today = new Date();
    const todayKey = getLocalDateKey(today);
    const yesterdayKey = getLocalDateKey(new Date(
      today.getFullYear(),
      today.getMonth(),
      today.getDate() - 1,
    ));
    setHabits((prev) => prev.map((habit) => (
      habit.id === habitId
        ? {
            ...habit,
            doneToday: !habit.doneToday,
            streak: !habit.doneToday && habit.lastCompletedDate !== todayKey
              ? habit.lastCompletedDate === yesterdayKey
                ? habit.streak + 1
                : 1
              : habit.streak,
            lastCompletedDate: !habit.doneToday ? todayKey : habit.lastCompletedDate,
            lastResetDate: todayKey,
          }
        : habit
    )));
  };

  const addHabit = (title) => {
    setHabits((prev) => [
      {
        id: `habit-${Date.now()}`,
        title,
        streak: 0,
        doneToday: false,
        lastResetDate: getLocalDateKey(),
      },
      ...prev,
    ]);
  };

  const deleteHabit = (habitId) => {
    setHabits((prev) => prev.filter((habit) => habit.id !== habitId));
  };

  const activeTasks = tasks.filter((task) => !isTaskComplete(task));
  const completedTasks = tasks.filter(isTaskComplete);
  const prioritizedTasks = getPrioritizedTasks(activeTasks);
  const urgentActiveTasks = prioritizedTasks.filter(isUrgentTask);
  const upcomingDeadlineTasks = prioritizedTasks
    .filter((task) => task.deadline && task.deadline !== 'Needs date')
    .slice(0, 3);
  const briefing = getDailyBriefing(tasks, events, habits);
  const analytics = getAnalytics(tasks, habits);
  const liveRecommendations = getLiveRecommendations(tasks, events, habits);
  const explicitFocusSessions = getExplicitFocusSessions(events);
  const selectedBreakdownTask = prioritizedTasks.find((task) => (
    Number.parseInt(task.estimated_time || task.estimate || 0, 10) >= 90
    || Array.isArray(task.subtasks) && task.subtasks.length > 0
    || /assignment|project|hackathon|report|essay|paper|exam|test|quiz|presentation/i.test(task.title || '')
  ));
  const selectedQuickTask = prioritizedTasks.find((task) => task.id !== selectedBreakdownTask?.id);

  return (
    <motion.section
      className="h-full w-full overflow-hidden rounded-[32px] border border-white/15 bg-[#07111f]/86 text-white shadow-[0_30px_100px_rgba(2,6,23,0.58)] backdrop-blur-2xl"
      initial={{ opacity: 0, scale: 0.92 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.94 }}
    >
      <header className="desktop-drag flex items-center justify-between border-b border-white/10 px-5 py-4">
        <div>
          <p className="text-[11px] font-black uppercase tracking-[0.26em] text-cyan-200">Promptly</p>
          <h1 className="mt-1 text-xl font-black">Desktop companion</h1>
        </div>
        <div className="no-drag flex items-center gap-2">
          {authUser?.provider === 'google' ? (
            <button
              type="button"
              onClick={onLogout}
              className="max-w-[132px] truncate rounded-full bg-emerald-300/15 px-3 py-2 text-xs font-black text-emerald-100 hover:bg-emerald-300/25"
              title={`Signed in as ${authUser.email || authUser.name}`}
            >
              {authUser.name || authUser.email}
            </button>
          ) : (
            <button
              type="button"
              onClick={onGoogleLogin}
              className="rounded-full bg-cyan-300 px-3 py-2 text-xs font-black text-slate-950 hover:bg-cyan-200"
            >
              Google login
            </button>
          )}
          <button
            type="button"
            onClick={onUndo}
            disabled={!canUndo}
            className="grid h-9 w-9 place-items-center rounded-full bg-white/10 text-slate-200 hover:bg-white/20 disabled:cursor-not-allowed disabled:opacity-35"
            title="Undo task change"
            aria-label="Undo task change"
          >
            <UndoIcon />
          </button>
          <button
            type="button"
            onClick={onRedo}
            disabled={!canRedo}
            className="grid h-9 w-9 place-items-center rounded-full bg-white/10 text-slate-200 hover:bg-white/20 disabled:cursor-not-allowed disabled:opacity-35"
            title="Redo task change"
            aria-label="Redo task change"
          >
            <UndoIcon redo />
          </button>
          <button type="button" onClick={onCollapse} className="rounded-full bg-white/10 px-3 py-2 text-xs font-bold hover:bg-white/20">
            Mini
          </button>
          <button type="button" onClick={onHide} className="rounded-full bg-white/10 px-3 py-2 text-xs font-bold hover:bg-white/20">
            Hide
          </button>
        </div>
      </header>

      <div className="grid h-[calc(100%-73px)] grid-rows-[minmax(0,1fr)_auto]">
        <div className="overflow-y-auto px-5 py-4">
          <BriefingPanel
            briefing={briefing}
            onBlockFreeSlot={blockFreeSlot}
            onRecoverTask={recoverMissedTask}
          />

          <div className="mt-4 grid gap-3 sm:grid-cols-3">
            {dashboard.cards.length ? (
              dashboard.cards.map((card) => <SmartCard key={card.id} card={card} />)
            ) : upcomingDeadlineTasks.length ? (
              upcomingDeadlineTasks.map((task) => (
                <div key={task.id || task.title} className={`rounded-3xl border p-4 shadow-lg shadow-slate-950/20 ${
                  isUrgentTask(task)
                    ? 'border-rose-300/25 bg-rose-300/[0.08]'
                    : 'border-white/10 bg-white/[0.05]'
                }`}>
                  <div className="flex items-center justify-between gap-3">
                    <p className="text-[11px] font-black uppercase tracking-[0.2em] text-slate-500">Upcoming deadline</p>
                    {isUrgentTask(task) ? (
                      <span className="rounded-full bg-rose-400/20 px-2 py-1 text-[10px] font-black uppercase text-rose-100">
                        Urgent
                      </span>
                    ) : null}
                  </div>
                  <h3 className="mt-2 truncate text-base font-black text-white">{task.title}</h3>
                  <p className="mt-2 text-sm text-slate-400">{getFriendlyDateTime(task.deadline)}</p>
                </div>
              ))
            ) : (
              <div className="rounded-3xl border border-white/10 bg-white/[0.05] p-4 shadow-lg shadow-slate-950/20 sm:col-span-3">
                <p className="text-[11px] font-black uppercase tracking-[0.2em] text-slate-500">Upcoming deadlines</p>
                <h3 className="mt-2 text-base font-black text-white">No upcoming deadlines</h3>
                <p className="mt-2 text-sm leading-5 text-slate-400">
                  Add a task with a due date and Promptly will surface it here.
                </p>
              </div>
            )}
          </div>

          <div className="mt-4 grid gap-4 lg:grid-cols-[1fr_0.9fr]">
            <section className="rounded-3xl border border-white/10 bg-white/[0.05] p-4">
              <div className="mb-3 flex items-center justify-between">
                <h2 className="font-black">Today&apos;s tasks</h2>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => downloadTaskExport(tasks, 'csv')}
                    className="rounded-full bg-white/10 px-3 py-1 text-xs font-black text-slate-200 hover:bg-white/20"
                  >
                    CSV
                  </button>
                  <button
                    type="button"
                    onClick={() => downloadTaskExport(tasks, 'json')}
                    className="rounded-full bg-white/10 px-3 py-1 text-xs font-black text-slate-200 hover:bg-white/20"
                  >
                    JSON
                  </button>
                  <span className="rounded-full bg-rose-400/20 px-3 py-1 text-xs font-black text-rose-100">
                    {urgentActiveTasks.length} urgent
                  </span>
                  <span className="rounded-full bg-emerald-400/15 px-3 py-1 text-xs font-black text-emerald-100">
                    {completedTasks.length} done
                  </span>
                </div>
              </div>
              <div className="mb-3 grid grid-cols-2 gap-2">
                <TaskStatusPill label="Not completed" count={activeTasks.length} />
                <TaskStatusPill label="Completed" count={completedTasks.length} tone="emerald" />
              </div>
              <div className="mb-3 flex flex-wrap gap-2">
                {!showManualTaskComposer ? (
                  <button
                    type="button"
                    onClick={() => setShowManualTaskComposer(true)}
                    className="rounded-full bg-cyan-300/15 px-4 py-2 text-xs font-black text-cyan-100 transition hover:bg-cyan-300/25"
                  >
                    Add task manually
                  </button>
                ) : null}
                <button
                  type="button"
                  onClick={() => setShowAllTasks((current) => !current)}
                  className="rounded-full bg-white/10 px-4 py-2 text-xs font-black text-slate-200 transition hover:bg-white/20"
                >
                  {showAllTasks ? 'Hide tasks' : `Show all tasks (${activeTasks.length})`}
                </button>
              </div>
              {showManualTaskComposer ? (
                <ManualTaskComposer
                  onAdd={addManualTask}
                  onCancel={() => setShowManualTaskComposer(false)}
                />
              ) : null}
              {showAllTasks ? (
                <div className="mt-3 space-y-2">
                  {activeTasks.length ? (
                    prioritizedTasks.map((task) => (
                        <TaskRow
                          key={task.id || task.title}
                          task={task}
                          onToggleComplete={toggleTaskComplete}
                          onDelete={deleteTask}
                          onMoveCategory={moveTaskToCategory}
                        />
                    ))
                  ) : (
                    <div className="rounded-2xl border border-dashed border-white/10 bg-white/[0.03] p-4 text-sm text-slate-400">
                      No active tasks for today.
                    </div>
                  )}
                </div>
              ) : null}

              <div className="mt-4 border-t border-white/10 pt-4">
                <h3 className="mb-3 text-sm font-black text-white">Task categories</h3>
                <div className="grid gap-3 xl:grid-cols-2">
                  {categories.map((item) => (
                    <CategoryBoard
                      key={item}
                      title={item}
                      tasks={activeTasks.filter((task) => String(task.category || '').toLowerCase() === item.toLowerCase())}
                      onMoveTask={moveTaskToCategory}
                      onToggleComplete={toggleTaskComplete}
                      onDeleteTask={deleteTask}
                    />
                  ))}
                  <CompletedBoard
                    tasks={completedTasks}
                    onToggleComplete={toggleTaskComplete}
                    onDeleteTask={deleteTask}
                    onMoveTask={moveTaskToCategory}
                    onClearCompleted={clearCompletedTasks}
                  />
                </div>
              </div>

              <div className="mt-4 border-t border-white/10 pt-4">
                <div className="mb-3 flex items-center justify-between">
                  <h3 className="text-sm font-black text-white">Reminders</h3>
                  <span className="rounded-full bg-cyan-400/15 px-3 py-1 text-xs font-black text-cyan-100">
                    {reminders.length}
                  </span>
                </div>
                <div className="space-y-2">
                  <ReminderComposer onAdd={addManualReminder} />
                  {reminders.length ? (
                    reminders.map((reminder) => (
                      <ReminderRow
                        key={reminder.id || reminder.title}
                        reminder={reminder}
                        onDelete={deleteReminder}
                      />
                    ))
                  ) : (
                    <div className="rounded-2xl border border-dashed border-cyan-300/20 bg-cyan-300/5 p-4 text-sm text-cyan-100/70">
                      No reminders added yet.
                    </div>
                  )}
                </div>
              </div>
            </section>

            <section className="rounded-3xl border border-white/10 bg-white/[0.05] p-4">
              <div className="mb-3 flex items-center justify-between">
                <h2 className="font-black">Calendar</h2>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={refreshCalendar}
                    className="rounded-full bg-white/10 px-3 py-1 text-xs font-black text-cyan-100 hover:bg-white/20"
                  >
                    Refresh
                  </button>
                  <span className="rounded-full bg-cyan-400/15 px-3 py-1 text-xs font-black text-cyan-100">
                    {calendarStatus.authorized ? 'connected' : 'offline'}
                  </span>
                </div>
              </div>
              {!calendarStatus.authorized ? (
                <div className="mb-3 rounded-2xl border border-dashed border-cyan-300/30 bg-cyan-300/10 p-3">
                  <p className="text-xs leading-5 text-cyan-100">
                    Google Calendar is not connected.
                  </p>
                  <button
                    type="button"
                    onClick={connectCalendar}
                    disabled={!calendarStatus.configured}
                    className="mt-2 rounded-full bg-cyan-300 px-3 py-2 text-xs font-black text-slate-950 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    Connect Google Calendar
                  </button>
                </div>
              ) : null}
              {calendarView === 'month' ? (
                <>
                  <CalendarBoard
                    events={events}
                    tasks={activeTasks}
                    selectedDate={selectedCalendarDate}
                    visibleMonth={visibleCalendarMonth}
                    onSelectDate={openCalendarDay}
                    onChangeMonth={changeCalendarMonth}
                    onToday={jumpToToday}
                  />
                  <div className="mt-3 space-y-2">
                    {events.length ? events.slice(0, 3).map((event) => (
                      <EventRow
                        key={event.id || event.title}
                        event={event}
                        onDelete={deleteCalendarEvent}
                      />
                    )) : (
                      <div className="rounded-2xl border border-dashed border-white/10 bg-white/[0.03] p-4 text-sm text-slate-400">
                        No calendar events found.
                      </div>
                    )}
                  </div>
                </>
              ) : (
                <div className="space-y-3">
                  <div className="flex items-center justify-between rounded-2xl border border-white/10 bg-slate-950/35 px-3 py-2">
                    <button
                      type="button"
                      onClick={() => setCalendarView('month')}
                      className="rounded-full bg-white/10 px-3 py-2 text-xs font-black text-cyan-100 hover:bg-white/20"
                    >
                      Back to month
                    </button>
                    <div className="text-right">
                      <p className="text-[10px] font-black uppercase tracking-[0.18em] text-slate-500">Selected day</p>
                      <p className="text-sm font-black text-white">
                        {selectedCalendarDate.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })}
                      </p>
                    </div>
                  </div>
                  <DayCalendarView
                    selectedDate={selectedCalendarDate}
                    events={events}
                    tasks={activeTasks}
                    onMoveTaskToSlot={moveTaskToCalendarSlot}
                  />
                </div>
              )}
            </section>
          </div>

          <div className="mt-4 grid gap-4 lg:grid-cols-3">
            <FocusPanel
              sessions={explicitFocusSessions}
              activeFocus={activeFocus}
              onStartFocus={setActiveFocus}
              onStopFocus={() => setActiveFocus(null)}
              onAddFocusSession={addManualFocusSession}
              onDeleteFocusSession={deleteFocusSession}
            />
            <HabitPanel
              habits={habits}
              onToggleHabit={toggleHabit}
              onAddHabit={addHabit}
              onDeleteHabit={deleteHabit}
            />
            <div className="space-y-4">
              <AnalyticsPanel analytics={analytics} />
              {selectedBreakdownTask ? (
                <TaskBreakdown task={selectedBreakdownTask} onToggleSubtask={toggleSubtask} />
              ) : (
                <QuickTaskActions
                  task={selectedQuickTask}
                  onComplete={toggleTaskComplete}
                  onReschedule={rescheduleTask}
                  onAddReminder={addTaskReminder}
                />
              )}
            </div>
          </div>

          <div className="mt-4 grid gap-4 lg:grid-cols-[1.15fr_0.85fr]">
            <ChatPanel
              messages={chatMessages}
              isThinking={isThinking}
              reminderResult={agentResult}
              onExecuteAction={executeAgentAction}
              executedTools={executedTools}
              dismissedTools={dismissedTools}
              onDismissAction={(tool) => setDismissedTools((prev) => new Set([...prev, tool]))}
              onRefreshChat={refreshChat}
              agentStatus={agentStatus}
            />
            <RecommendationPanel
              liveRecommendations={liveRecommendations}
              agentDigest={agentDigest}
            />
          </div>
        </div>

        <footer className="border-t border-white/10 bg-slate-950/70 px-4 pb-7 pt-4">
          <div className="mb-3 flex gap-2">
            {categories.map((item) => (
              <button
                key={item}
                type="button"
                onClick={() => setCategory(item)}
                className={`rounded-full px-3 py-1.5 text-xs font-black ${
                  category === item ? 'bg-cyan-300 text-slate-950' : 'bg-white/10 text-slate-300'
                }`}
              >
                {item}
              </button>
            ))}
          </div>
          <div className="no-drag flex items-end gap-2 rounded-3xl border border-white/10 bg-white/[0.06] p-2">
            <textarea
              value={input}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault();
                  submit();
                }
              }}
              rows={1}
              placeholder="Message Promptly..."
              className="max-h-24 min-h-11 flex-1 resize-none bg-transparent px-3 py-3 text-sm text-white outline-none placeholder:text-slate-500"
            />
            <button
              type="button"
              onClick={speech.start}
              disabled={!speech.supported}
              className={`grid h-11 w-11 place-items-center rounded-full ${speech.isListening ? 'bg-rose-500' : 'bg-white/10 hover:bg-white/20'}`}
            >
              Mic
            </button>
            <button
              type="button"
              onClick={() => submit()}
              disabled={!input.trim() || isThinking}
              className="grid h-11 w-11 place-items-center rounded-full bg-cyan-300 font-black text-slate-950 disabled:opacity-40"
            >
              Send
            </button>
          </div>
        </footer>
      </div>
    </motion.section>
  );
}

function PromptlyWidgetApp({ onHiddenChange, onModeChange }) {
  const isDesktopApp = Boolean(window.promptlyDesktop);
  const [mode, setMode] = useState('mini');
  const [dashboard] = useState(getInitialDashboard);
  const [tasks, setTasksState] = useState(() => dedupeTasksByTitle(dashboard.tasks));
  const [reminders, setReminders] = useState(dashboard.reminders || []);
  const [events, setEvents] = useState(dashboard.events);
  const [habits, setHabits] = useState(dashboard.habits || []);
  const tasksRef = useRef(dedupeTasksByTitle(dashboard.tasks));
  const taskHistoryRef = useRef({ past: [], future: [] });
  const [calendarStatus, setCalendarStatus] = useState({ configured: false, authorized: false });
  const [agentStatus, setAgentStatus] = useState({
    backend: 'offline',
    mode: 'fallback',
    model_ready: false,
  });
  const [authUser, setAuthUser] = useState(getStoredAuthUser);
  const [widgetHidden, setWidgetHidden] = useState(
    () => !window.promptlyDesktop && window.localStorage.getItem('promptly-widget-hidden') === 'true',
  );

  const revealWidget = (nextMode = 'mini') => {
    window.localStorage.removeItem('promptly-widget-hidden');
    document.documentElement.classList.remove('promptly-hidden');
    setWidgetHidden(false);
    onHiddenChange?.(false);
    setMode(nextMode);
    onModeChange?.(nextMode);
  };

  const setTasks = (updater) => {
    setTasksState((current) => {
      const next = dedupeTasksByTitle(typeof updater === 'function' ? updater(current) : updater);
      if (next === current) return current;
      taskHistoryRef.current.past = [...taskHistoryRef.current.past.slice(-29), current];
      taskHistoryRef.current.future = [];
      tasksRef.current = next;
      return next;
    });
  };

  const undoTasks = () => {
    const previous = taskHistoryRef.current.past.pop();
    if (!previous) return;
    taskHistoryRef.current.future.push(tasksRef.current);
    tasksRef.current = previous;
    setTasksState(previous);
  };

  const redoTasks = () => {
    const next = taskHistoryRef.current.future.pop();
    if (!next) return;
    taskHistoryRef.current.past.push(tasksRef.current);
    tasksRef.current = next;
    setTasksState(next);
  };

  const refreshAgentStatus = async () => {
    const nextStatus = await getAgentStatus();
    setAgentStatus(nextStatus);
    return nextStatus;
  };

  const refreshBackendState = async () => {
    if (!hasBackendSession()) return false;
    try {
      const [backendTasks, backendEvents, backendReminders] = await Promise.all([
        getBackendTasks(),
        getBackendEvents(),
        getBackendReminders(),
      ]);
      const nextTasks = dedupeTasksByTitle(backendTasks || []);
      tasksRef.current = nextTasks;
      taskHistoryRef.current = { past: [], future: [] };
      setTasksState(nextTasks);
      setEvents((prev) => {
        const googleEvents = prev.filter((event) => (
          typeof event.id === 'string'
          && !event.id.startsWith('agent-event-')
          && !event.id.startsWith('local-event-')
        ));
        return [...(backendEvents || []), ...googleEvents];
      });
      setReminders((backendReminders || []).map((reminder) => ({
        ...reminder,
        time: reminder.due_at,
      })));
      return true;
    } catch {
      return false;
    }
  };

  const refreshCalendar = async () => {
    const status = await getCalendarStatus();
    setCalendarStatus(status);
    const nextEvents = await getCalendarEvents();
    setEvents((prev) => {
      const localEvents = prev.filter((event) => (
        typeof event.id === 'number'
        || String(event.id || '').startsWith('agent-event-')
        || String(event.id || '').startsWith('local-event-')
      ));
      const googleIds = new Set(nextEvents.map((event) => String(event.id || '')));
      const uniqueLocalEvents = localEvents.filter(
        (event) => !googleIds.has(String(event.id || '')),
      );
      return [...nextEvents, ...uniqueLocalEvents];
    });
  };

  useEffect(() => {
    const removeModeListener = window.promptlyDesktop?.onModeChange?.((nextMode) => {
      revealWidget(nextMode);
    });
    const removeShowListener = window.promptlyDesktop?.onShow?.(() => {
      revealWidget('mini');
    });
    const initialize = async () => {
      try {
        const redirectedUser = consumeGoogleAuthRedirect();
        if (redirectedUser) setAuthUser(redirectedUser);
      } catch (error) {
        window.alert(error.message || 'Google login failed.');
      }
      await ensureDesktopSession();
      const currentUser = await getCurrentUser();
      if (currentUser) setAuthUser({
        ...currentUser,
        provider: currentUser.email === 'desktop@promptly.app' ? 'desktop' : 'google',
      });
      await refreshBackendState();
      await refreshCalendar();
      await refreshAgentStatus();
    };
    initialize();
    const statusTimer = window.setInterval(async () => {
      const nextStatus = await getAgentStatus();
      setAgentStatus(nextStatus);
    }, 15000);
    return () => {
      removeModeListener?.();
      removeShowListener?.();
      window.clearInterval(statusTimer);
    };
  }, []);

  useEffect(() => {
    const mistralHealthy = ['mistral', 'mistral_api'].includes(agentStatus.mode)
      && agentStatus.model_ready;
    if (!mistralHealthy) return;
    window.localStorage.removeItem('promptly-last-model-error');
  }, [agentStatus]);

  useEffect(() => {
    window.localStorage.setItem('promptly-tasks', JSON.stringify(dedupeTasksByTitle(tasks)));
  }, [tasks]);

  useEffect(() => {
    window.localStorage.setItem('promptly-reminders', JSON.stringify(reminders));
  }, [reminders]);

  useEffect(() => {
    window.localStorage.setItem('promptly-habits', JSON.stringify(habits));
  }, [habits]);

  useEffect(() => {
    window.localStorage.setItem('promptly-events', JSON.stringify(events));
  }, [events]);

  const setDesktopMode = (nextMode) => {
    setMode(nextMode);
    onModeChange?.(nextMode);
    window.promptlyDesktop?.setMode?.(nextMode);
  };

  const startGoogleLogin = async () => {
    try {
      const url = await getGoogleLoginUrl();
      window.location.assign(url);
    } catch (error) {
      window.alert(error.message || 'Could not start Google login.');
    }
  };

  const logout = async () => {
    await logoutBackendSession();
    setAuthUser(null);
    await ensureDesktopSession();
    const currentUser = await getCurrentUser();
    if (currentUser) setAuthUser({ ...currentUser, provider: 'desktop' });
    await refreshBackendState();
  };

  const hideWidget = async () => {
    window.localStorage.setItem('promptly-widget-hidden', 'true');
    setWidgetHidden(true);
    onHiddenChange?.(true);
    await setDesktopWidgetHidden(true);
    if (window.promptlyDesktop?.hide) {
      await window.promptlyDesktop.hide();
      return;
    }
  };

  const unhideWidget = async () => {
    await requestDesktopWidgetUnhide();
    revealWidget('mini');
    window.promptlyDesktop?.setMode?.('mini');
  };

  useEffect(() => {
    if (widgetHidden && window.promptlyDesktop?.hide) {
      window.promptlyDesktop.hide();
    }
    document.documentElement.classList.toggle(
      'promptly-hidden',
      widgetHidden && isDesktopApp,
    );
    return () => document.documentElement.classList.remove('promptly-hidden');
  }, [isDesktopApp, widgetHidden]);

  if (widgetHidden && isDesktopApp) {
    return null;
  }

  if (widgetHidden) return null;

  return (
    <main className="h-full w-full overflow-hidden bg-transparent">
      <AnimatePresence mode="wait">
        {mode === 'mini' ? (
          <MiniMode
            key="mini"
            urgentCount={tasks.filter((task) => task.priority === 'high' && !isTaskComplete(task)).length}
            nextEvent={events[0]?.title || ''}
            onExpand={() => setDesktopMode('expanded')}
          />
        ) : (
          <ExpandedMode
            key="expanded"
            dashboard={dashboard}
            tasks={tasks}
            setTasks={setTasks}
            canUndo={taskHistoryRef.current.past.length > 0}
            canRedo={taskHistoryRef.current.future.length > 0}
            onUndo={undoTasks}
            onRedo={redoTasks}
            reminders={reminders}
            setReminders={setReminders}
            events={events}
            setEvents={setEvents}
            habits={habits}
            setHabits={setHabits}
            calendarStatus={calendarStatus}
            agentStatus={agentStatus}
            authUser={authUser}
            onGoogleLogin={startGoogleLogin}
            onLogout={logout}
            onHide={hideWidget}
            refreshAgentStatus={refreshAgentStatus}
            refreshCalendar={refreshCalendar}
            refreshBackendState={refreshBackendState}
            onCollapse={() => setDesktopMode('mini')}
          />
        )}
      </AnimatePresence>
    </main>
  );
}

function WebDashboard({ widgetHidden, onShowWidget }) {
  return (
    <main className="min-h-screen bg-slate-50 text-slate-950">
      <header className="sticky top-0 z-20 border-b border-slate-200/80 bg-white/88 backdrop-blur-xl">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-5 py-4">
          <div>
            <p className="text-[11px] font-black uppercase tracking-[0.24em] text-cyan-700">Promptly</p>
            <h1 className="text-xl font-black">AI productivity dashboard</h1>
          </div>
          {widgetHidden ? (
            <button
              type="button"
              onClick={onShowWidget}
              className="rounded-full bg-slate-950 px-4 py-2 text-sm font-black text-white shadow-lg shadow-slate-300/70 transition hover:bg-slate-800"
            >
              Show Promptly Widget
            </button>
          ) : null}
        </div>
      </header>

      <section className="mx-auto grid max-w-6xl gap-6 px-5 py-8 lg:grid-cols-[1.05fr_0.95fr]">
        <div className="rounded-[8px] border border-slate-200 bg-white p-6 shadow-sm">
          <p className="text-sm font-bold text-cyan-700">Welcome back</p>
          <h2 className="mt-2 text-3xl font-black tracking-normal text-slate-950">Plan today with Promptly beside you.</h2>
          <p className="mt-3 max-w-2xl text-base leading-7 text-slate-600">
            Use the floating widget to capture tasks, create reminders, schedule focus blocks, and connect Google Calendar without leaving this dashboard.
          </p>
          <div className="mt-6 grid gap-3 sm:grid-cols-3">
            <div className="rounded-[8px] border border-slate-200 bg-slate-50 p-4">
              <p className="text-2xl font-black text-slate-950">Tasks</p>
              <p className="mt-1 text-sm leading-5 text-slate-600">Capture and prioritize work by category.</p>
            </div>
            <div className="rounded-[8px] border border-slate-200 bg-slate-50 p-4">
              <p className="text-2xl font-black text-slate-950">Calendar</p>
              <p className="mt-1 text-sm leading-5 text-slate-600">Sync events and turn tasks into time blocks.</p>
            </div>
            <div className="rounded-[8px] border border-slate-200 bg-slate-50 p-4">
              <p className="text-2xl font-black text-slate-950">Focus</p>
              <p className="mt-1 text-sm leading-5 text-slate-600">Start sessions and track habits for the day.</p>
            </div>
          </div>
        </div>

        <div className="grid gap-4">
          <section className="rounded-[8px] border border-slate-200 bg-white p-5 shadow-sm">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-black">Today&apos;s command center</h2>
              <span className="rounded-full bg-emerald-100 px-3 py-1 text-xs font-black text-emerald-800">Live</span>
            </div>
            <div className="mt-4 space-y-3">
              {['Ask Promptly to add a task', 'Connect Google Calendar', 'Review reminders and focus sessions'].map((item) => (
                <div key={item} className="flex items-center justify-between rounded-[8px] border border-slate-200 bg-slate-50 px-4 py-3">
                  <span className="text-sm font-bold text-slate-700">{item}</span>
                  <span className="h-2.5 w-2.5 rounded-full bg-cyan-500" />
                </div>
              ))}
            </div>
          </section>
          <section className="rounded-[8px] border border-slate-200 bg-white p-5 shadow-sm">
            <h2 className="text-lg font-black">Widget status</h2>
            <p className="mt-2 text-sm leading-6 text-slate-600">
              {widgetHidden
                ? 'The floating widget is hidden for this browser.'
                : 'The floating Promptly widget is ready in the bottom-right corner.'}
            </p>
          </section>
        </div>
      </section>

      {widgetHidden ? (
        <button
          type="button"
          onClick={onShowWidget}
          className="fixed bottom-6 right-6 z-[9999] rounded-full bg-slate-950 px-4 py-3 text-sm font-black text-white shadow-2xl shadow-slate-400/60 transition hover:bg-slate-800"
        >
          Show Promptly Widget
        </button>
      ) : null}
    </main>
  );
}

function PromptlyWebApp() {
  const [widgetHidden, setWidgetHidden] = useState(
    () => window.localStorage.getItem('promptly-widget-hidden') === 'true',
  );
  const [widgetMode, setWidgetMode] = useState('mini');

  const showWidget = async () => {
    window.localStorage.removeItem('promptly-widget-hidden');
    await requestDesktopWidgetUnhide();
    setWidgetMode('mini');
    setWidgetHidden(false);
  };

  return (
    <>
      <WebDashboard widgetHidden={widgetHidden} onShowWidget={showWidget} />
      {!widgetHidden ? (
        <div
          className="fixed bottom-6 right-6 z-[9999] h-16 w-16 data-[mode=expanded]:h-[min(80vh,720px)] data-[mode=expanded]:w-[min(420px,calc(100vw-48px))]"
          data-mode={widgetMode}
        >
          <PromptlyWidgetApp onHiddenChange={setWidgetHidden} onModeChange={setWidgetMode} />
        </div>
      ) : null}
    </>
  );
}

function PromptlyApp() {
  const isDesktopApp = Boolean(window.promptlyDesktop);

  useEffect(() => {
    document.documentElement.classList.toggle('promptly-desktop-runtime', isDesktopApp);
    return () => document.documentElement.classList.remove('promptly-desktop-runtime');
  }, [isDesktopApp]);

  if (isDesktopApp) {
    return (
      <div className="h-screen w-screen">
        <PromptlyWidgetApp />
      </div>
    );
  }

  return <PromptlyWebApp />;
}

createRoot(document.getElementById('root')).render(<PromptlyApp />);
