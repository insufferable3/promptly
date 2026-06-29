const categoryWeights = {
  Study: 12,
  Work: 10,
  Personal: 6,
};

const breakdownTemplates = [
  {
    match: /hackathon|project|app|website|product/i,
    steps: ['Research', 'Architecture', 'Backend', 'Frontend', 'Testing', 'Deployment', 'Presentation'],
  },
  {
    match: /assignment|report|essay|paper/i,
    steps: ['Understand rubric', 'Research', 'Outline', 'First draft', 'Review', 'Final submission'],
  },
  {
    match: /exam|test|quiz/i,
    steps: ['List syllabus', 'Revise concepts', 'Practice problems', 'Mock test', 'Error review'],
  },
];

function parseDate(value) {
  if (!value) return null;
  const parsed = new Date(value);
  if (!Number.isNaN(parsed.getTime())) return parsed;
  const lower = String(value).toLowerCase();
  const now = new Date();
  const timeMatch = lower.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
  let dayOffset = 0;
  if (lower.includes('tomorrow')) dayOffset = 1;
  if (lower.includes('yesterday')) dayOffset = -1;
  const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() + dayOffset, 18, 0, 0, 0);
  if (timeMatch) {
    let hour = Number(timeMatch[1]);
    const minute = Number(timeMatch[2] || 0);
    const meridiem = timeMatch[3]?.toLowerCase();
    if (meridiem === 'pm' && hour < 12) hour += 12;
    if (meridiem === 'am' && hour === 12) hour = 0;
    if (!meridiem && hour >= 1 && hour <= 7) hour += 12;
    date.setHours(hour, minute, 0, 0);
  }
  return date;
}

export function scoreTask(task, now = new Date()) {
  const deadline = parseDate(task.deadline || task.due || task.time);
  const hoursUntilDeadline = deadline ? (deadline.getTime() - now.getTime()) / 36e5 : 96;
  const overdue = deadline ? hoursUntilDeadline < 0 : false;
  const effort = Number.parseInt(task.estimated_time || task.estimate || 45, 10) || 45;
  const deadlineScore = overdue ? 40 : Math.max(0, 34 - Math.max(hoursUntilDeadline, 0) / 3);
  const effortScore = Math.min(18, effort / 8);
  const priorityScore = { high: 24, medium: 14, low: 6 }[String(task.priority || 'medium').toLowerCase()] || 12;
  const categoryScore = categoryWeights[task.category] || 8;
  const score = Math.round(Math.min(100, deadlineScore + effortScore + priorityScore + categoryScore));

  const explanation = overdue
    ? 'Overdue and needs recovery planning.'
    : deadline && hoursUntilDeadline <= 24
      ? 'Deadline is close, schedule this before lower-pressure work.'
      : effort >= 90
        ? 'Large task, break it into focus blocks.'
        : 'Good candidate for a short focus session.';

  return {
    score,
    explanation,
    overdue,
    deadline,
    hoursUntilDeadline,
  };
}

export function getPrioritizedTasks(tasks) {
  return tasks
    .map((task) => ({ ...task, priorityMeta: scoreTask(task) }))
    .sort((a, b) => b.priorityMeta.score - a.priorityMeta.score);
}

export function createSubtasks(task) {
  const template = breakdownTemplates.find((item) => item.match.test(task.title || ''));
  const steps = template?.steps || ['Clarify outcome', 'Plan next step', 'Do first focus block', 'Review result'];
  return steps.map((title, index) => ({
    id: `${task.id || task.title}-subtask-${index}`,
    title,
    done: false,
  }));
}

export function getTaskProgress(task) {
  const subtasks = task.subtasks?.length ? task.subtasks : createSubtasks(task);
  const done = subtasks.filter((subtask) => subtask.done).length;
  return {
    subtasks,
    percent: subtasks.length ? Math.round((done / subtasks.length) * 100) : 0,
  };
}

export function getSuggestedFocusSessions(tasks, events = []) {
  const topTasks = getPrioritizedTasks(tasks).slice(0, 3);
  const busyHours = new Set(events.map((event) => {
    const date = parseDate(event.start_time || event.start);
    return date?.getHours();
  }).filter((hour) => hour !== undefined));
  const candidateHours = [9, 11, 14, 16, 19, 21];

  return topTasks.map((task, index) => {
    const hour = candidateHours.find((candidate) => !busyHours.has(candidate)) || candidateHours[index + 1] || 19;
    busyHours.add(hour);
    return {
      id: `focus-${task.id || index}`,
      taskId: task.id,
      title: task.title,
      duration: task.priorityMeta.score >= 80 ? 90 : task.priorityMeta.score >= 55 ? 50 : 25,
      hour,
    };
  });
}

function findFreeSlot(tasks, events, now = new Date(), workStartHour = 9, workEndHour = 18) {
  const task = getPrioritizedTasks(tasks).find((item) => !item.priorityMeta.overdue);
  if (!task) return null;
  const requestedMinutes = Math.min(90, Math.max(25, Number.parseInt(
    task.estimated_time || task.estimate || 45,
    10,
  ) || 45));

  for (let dayOffset = 0; dayOffset < 7; dayOffset += 1) {
    const dayStart = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate() + dayOffset,
      workStartHour,
      0,
      0,
      0,
    );
    const dayEnd = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate() + dayOffset,
      workEndHour,
      0,
      0,
      0,
    );
    let cursor = dayOffset === 0 && now > dayStart
      ? new Date(Math.ceil(now.getTime() / 1800000) * 1800000)
      : dayStart;
    if (cursor < dayStart) cursor = dayStart;

    const busy = events
      .map((event) => ({
        start: parseDate(event.start_time || event.start),
        end: parseDate(event.end_time || event.end),
      }))
      .filter((event) => event.start && event.end && event.start < dayEnd && event.end > dayStart)
      .sort((left, right) => left.start - right.start);

    for (const event of busy) {
      const candidateEnd = new Date(cursor.getTime() + requestedMinutes * 60000);
      if (candidateEnd <= event.start && candidateEnd <= dayEnd) {
        return { task, start: cursor, end: candidateEnd, duration: requestedMinutes };
      }
      if (event.end > cursor) cursor = event.end;
    }
    const candidateEnd = new Date(cursor.getTime() + requestedMinutes * 60000);
    if (candidateEnd <= dayEnd) {
      return { task, start: cursor, end: candidateEnd, duration: requestedMinutes };
    }
  }
  return null;
}

export function getDailyBriefing(tasks, events = [], habits = []) {
  const activeTasks = tasks.filter((task) => String(task.status || '').toLowerCase() !== 'completed');
  const prioritized = getPrioritizedTasks(activeTasks);
  const urgentDeadlines = prioritized.filter((task) => task.priorityMeta.score >= 65 || task.priorityMeta.overdue).slice(0, 3);
  const missedTasks = prioritized.filter((task) => task.priorityMeta.overdue).slice(0, 3);
  const focusSessions = [];
  const workloadMinutes = activeTasks.reduce((total, task) => {
    const effort = Number.parseInt(task.estimated_time || task.estimate || 45, 10) || 45;
    return total + effort;
  }, 0);
  const conflicts = events.filter((event, index) => {
    const start = parseDate(event.start_time || event.start);
    const end = parseDate(event.end_time || event.end);
    if (!start || !end) return false;
    return events.some((other, otherIndex) => {
      if (index === otherIndex) return false;
      const otherStart = parseDate(other.start_time || other.start);
      const otherEnd = parseDate(other.end_time || other.end);
      return otherStart && otherEnd && start < otherEnd && otherStart < end;
    });
  });

  return {
    topTasks: prioritized.slice(0, 3),
    urgentDeadlines,
    missedTasks,
    freeSlot: findFreeSlot(activeTasks, events),
    focusSessions,
    conflicts,
    eventCount: events.length,
    workloadMinutes,
    workloadLabel: `${Math.floor(workloadMinutes / 60)}h ${workloadMinutes % 60}m`,
    habitConsistency: habits.length
      ? Math.round((habits.filter((habit) => habit.doneToday).length / habits.length) * 100)
      : 0,
  };
}

export function getAnalytics(tasks, habits = []) {
  const completed = tasks.filter((task) => String(task.status || '').toLowerCase() === 'completed');
  const missed = tasks.filter((task) => scoreTask(task).overdue && String(task.status || '').toLowerCase() !== 'completed');
  const completionRate = tasks.length ? Math.round((completed.length / tasks.length) * 100) : 0;
  const hasEnoughData = completed.length >= 3;
  return {
    completed: completed.length,
    missed: missed.length,
    completionRate,
    hasEnoughData,
    productivityScore: hasEnoughData
      ? Math.max(0, Math.round(completionRate * 0.65 + Math.max(0, 35 - missed.length * 8)))
      : null,
    habitConsistency: habits.length
      ? Math.round((habits.filter((habit) => habit.doneToday).length / habits.length) * 100)
      : 0,
    mostProductiveHour: 'Not enough data',
  };
}

function formatTime(date) {
  return date?.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) || '';
}

export function getLiveRecommendations(tasks, events = [], habits = [], now = new Date()) {
  const activeTasks = tasks.filter((task) => String(task.status || '').toLowerCase() !== 'completed');
  const completedTasks = tasks.filter((task) => String(task.status || '').toLowerCase() === 'completed');
  const prioritized = getPrioritizedTasks(activeTasks);
  const briefing = getDailyBriefing(tasks, events, habits);
  const topTask = prioritized[0];
  const overdue = prioritized.filter((task) => task.priorityMeta.overdue);
  const dueSoon = prioritized.filter((task) => {
    const hours = task.priorityMeta.hoursUntilDeadline;
    return hours >= 0 && hours <= 24;
  });
  const largeTasks = prioritized.filter((task) => (
    Number.parseInt(task.estimated_time || task.estimate || 45, 10) >= 90
  ));
  const noDeadlineTasks = activeTasks.filter((task) => !parseDate(task.deadline || task.due || task.time));
  const doneToday = completedTasks.filter((task) => {
    const completedAt = parseDate(task.completed_at || task.completedAt);
    return completedAt
      ? completedAt.toDateString() === now.toDateString()
      : true;
  });
  const workloadHours = Math.round((briefing.workloadMinutes / 60) * 10) / 10;
  const focusSlot = briefing.freeSlot;
  const insightItems = [];

  if (overdue.length) {
    insightItems.push({
      tone: 'rose',
      title: 'Recovery first',
      detail: `${overdue.length} task${overdue.length === 1 ? ' is' : 's are'} overdue. Reschedule the oldest one before adding more work.`,
    });
  }
  if (dueSoon.length) {
    insightItems.push({
      tone: 'amber',
      title: 'Deadline pressure',
      detail: `${dueSoon.length} task${dueSoon.length === 1 ? '' : 's'} due in 24h. Protect a focus block now.`,
    });
  }
  if (briefing.conflicts.length) {
    insightItems.push({
      tone: 'rose',
      title: 'Calendar conflict',
      detail: `${briefing.conflicts.length} overlapping calendar item${briefing.conflicts.length === 1 ? '' : 's'} need cleanup.`,
    });
  }
  if (largeTasks.length) {
    insightItems.push({
      tone: 'violet',
      title: 'Break it down',
      detail: `${largeTasks[0].title} is large. Split it into 25-45 minute blocks.`,
    });
  }
  if (noDeadlineTasks.length >= 3) {
    insightItems.push({
      tone: 'cyan',
      title: 'Add dates',
      detail: `${noDeadlineTasks.length} active tasks have no deadline, so prioritization is less accurate.`,
    });
  }
  if (!insightItems.length && topTask) {
    insightItems.push({
      tone: 'emerald',
      title: 'Clear next step',
      detail: `Start ${topTask.title}; it has the strongest mix of urgency, effort, and priority.`,
    });
  }
  if (!insightItems.length) {
    insightItems.push({
      tone: 'cyan',
      title: 'Plan ready',
      detail: 'Add one task with a deadline and Promptly will calculate what matters next.',
    });
  }

  const nextAction = topTask
    ? {
        title: topTask.title,
        reason: topTask.priorityMeta.explanation,
        score: topTask.priorityMeta.score,
        duration: Math.min(90, Math.max(25, Number.parseInt(topTask.estimated_time || topTask.estimate || 45, 10) || 45)),
      }
    : null;

  const focusSuggestion = focusSlot
    ? `Free ${formatTime(focusSlot.start)}-${formatTime(focusSlot.end)} for ${focusSlot.task.title}.`
    : topTask
      ? `No clean free slot found; do a 25 minute sprint on ${topTask.title}.`
      : 'No focus block needed yet.';

  const efficiencyScore = Math.max(
    0,
    Math.min(
      100,
      Math.round(
        72
        + Math.min(doneToday.length * 5, 15)
        - overdue.length * 14
        - dueSoon.length * 4
        - briefing.conflicts.length * 8
        - Math.max(0, workloadHours - 6) * 4
        + (briefing.habitConsistency >= 50 ? 5 : 0),
      ),
    ),
  );

  return {
    generatedAt: now.toISOString(),
    efficiencyScore,
    workloadHours,
    nextAction,
    focusSuggestion,
    insightItems: insightItems.slice(0, 3),
    stats: {
      overdue: overdue.length,
      dueSoon: dueSoon.length,
      conflicts: briefing.conflicts.length,
      active: activeTasks.length,
      completed: completedTasks.length,
    },
  };
}
