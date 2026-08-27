// Server-side port of the audit-row logic behind the Submissions Report
// sheet. This used to live only in js/business.js and run client-side —
// every checklist submission called syncSubmissionReport(), which posted
// that browser's locally-computed rows to /api/submission-report-sync for a
// full clear+rewrite of the sheet. Any browser tab still running an older
// build of that logic would silently overwrite the sheet with stale/buggy
// output on its next submission. Running the same computation here, from
// the store data the server already has, means the sheet is always rebuilt
// with whatever's actually deployed, regardless of which client triggered it.
//
// Kept as a faithful line-for-line port of the client versions (see
// js/utils.js and js/business.js for the originals) rather than a
// reimplementation, specifically so behavior can't quietly drift between
// the live dashboard and this report. If the client logic changes, mirror
// the change here too.

function normalizePersonName(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeTaskTitle(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeFrequency(value) {
  return (value || "one_time").toLowerCase();
}

function isArunMishraTask(task) {
  const assigneeName = normalizePersonName(task?.assigneeName);
  return assigneeName === "arun mishra" || assigneeName === "abhishiek kumar";
}

function isAcFilterCleaningTask(task) {
  const title = normalizeTaskTitle(task?.title);
  return title.includes("ac filter cleaning");
}

function isLockOilingCleaningTask(task) {
  const title = normalizeTaskTitle(task?.title);
  return title.includes("locks being oiling") || title.includes("locks being oil");
}

function isCameraFunctioningTask(task) {
  const title = normalizeTaskTitle(task?.title);
  return title.includes("camera functioning");
}

function isKamalPantryTask(task) {
  return normalizePersonName(task?.assigneeName) === "kamal"
    && normalizeTaskTitle(task?.title) === "pantry";
}

function isEarthingCleaningTask(task) {
  return normalizeTaskTitle(task?.title).includes("earthing and cleaning");
}

function isGeneratorChecklistTask(task) {
  return normalizeTaskTitle(task?.title).includes("generator checklist");
}

function applyTaskScheduleOverrides(task) {
  if (!task) {
    return task;
  }

  const overrides = {};
  if (isArunMishraTask(task) && isAcFilterCleaningTask(task)) {
    overrides.frequency = "daily";
    overrides.displayFrequency = "every_15_days";
  }
  if (isKamalPantryTask(task)) {
    overrides.frequency = "weekly";
    overrides.displayFrequency = "weekly";
  }

  return Object.keys(overrides).length ? { ...task, ...overrides } : task;
}

function shouldSplitTaskIntoDayParts(task) {
  return isArunMishraTask(task)
    && normalizeFrequency(task?.frequency) === "daily"
    && !isAcFilterCleaningTask(task)
    && !isEarthingCleaningTask(task)
    && !isLockOilingCleaningTask(task)
    && !isCameraFunctioningTask(task);
}

function getTaskDayParts(task) {
  if (!shouldSplitTaskIntoDayParts(task)) {
    return [];
  }

  if (isGeneratorChecklistTask(task)) {
    return [{ id: "morning", label: "Morning" }];
  }

  return [
    { id: "morning", label: "Morning" },
    { id: "evening", label: "Evening" },
  ];
}

function getCompletionKey(task) {
  const slotKey = task.occurrenceSlot ? `__${task.occurrenceSlot}` : "";
  const customerKey = task.customerAttributionKey ? `__cust_${task.customerAttributionKey}` : "";
  return `${task.taskId || task.id}__${task.occurrenceDate}${slotKey}${customerKey}`;
}

function getTaskDisplayTitle(task) {
  return task.occurrenceSlotLabel ? `${task.title} (${task.occurrenceSlotLabel})` : task.title;
}

function getTaskReferenceDate(task) {
  if (task.occurrenceDate) {
    return new Date(`${task.occurrenceDate}T00:00:00`);
  }
  if (task.plannedDate) {
    return new Date(`${task.plannedDate}T00:00:00`);
  }
  if (task.createdAt) {
    return new Date(task.createdAt);
  }
  return new Date();
}

function dateToLocalValue(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function startOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function endOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 23, 59, 59, 999);
}

function getStartOfWeek(date) {
  const result = startOfDay(date);
  const day = result.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  result.setDate(result.getDate() + diff);
  return result;
}

function subtractDays(date, days) {
  const nextDate = new Date(date);
  nextDate.setDate(nextDate.getDate() - days);
  return nextDate;
}

function createTaskOccurrence(task, date, extra = {}) {
  const isWeekly = normalizeFrequency(task.frequency) === "weekly";
  const occurrenceBaseDate = isWeekly ? getStartOfWeek(new Date(date)) : new Date(date);
  return {
    ...task,
    ...extra,
    occurrenceDate: dateToLocalValue(occurrenceBaseDate),
  };
}

function createTaskOccurrencesForDate(task, date) {
  const dayParts = getTaskDayParts(task);
  if (!dayParts.length) {
    return [createTaskOccurrence(task, date)];
  }

  return dayParts.map((part) =>
    createTaskOccurrence(task, date, {
      occurrenceSlot: part.id,
      occurrenceSlotLabel: part.label,
    })
  );
}

function buildDailyEntries(task, startDate, rangeStart, rangeEnd) {
  const entries = [];
  const cursor = new Date(Math.max(startDate.getTime(), rangeStart.getTime()));

  while (cursor <= rangeEnd) {
    entries.push(...createTaskOccurrencesForDate(task, cursor));
    cursor.setDate(cursor.getDate() + 1);
  }

  return entries;
}

function buildWeeklyEntries(task, startDate, rangeStart, rangeEnd) {
  const entries = [];
  const cursor = new Date(startDate);

  while (cursor < rangeStart) {
    cursor.setDate(cursor.getDate() + 7);
  }

  while (cursor <= rangeEnd) {
    entries.push(...createTaskOccurrencesForDate(task, cursor));
    cursor.setDate(cursor.getDate() + 7);
  }

  return entries;
}

function buildEvery15DayEntries(task, startDate, rangeStart, rangeEnd) {
  const entries = [];
  const cursor = new Date(startDate);

  while (cursor < rangeStart) {
    cursor.setDate(cursor.getDate() + 15);
  }

  while (cursor <= rangeEnd) {
    entries.push(...createTaskOccurrencesForDate(task, cursor));
    cursor.setDate(cursor.getDate() + 15);
  }

  return entries;
}

function buildMonthlyEntries(task, startDate, rangeStart, rangeEnd) {
  const entries = [];
  const cursor = new Date(startDate);

  while (cursor < rangeStart) {
    cursor.setMonth(cursor.getMonth() + 1);
  }

  while (cursor <= rangeEnd) {
    entries.push(...createTaskOccurrencesForDate(task, cursor));
    cursor.setMonth(cursor.getMonth() + 1);
  }

  return entries;
}

function buildQuarterlyEntries(task, startDate, rangeStart, rangeEnd) {
  const entries = [];
  const cursor = new Date(startDate);

  while (cursor < rangeStart) {
    cursor.setMonth(cursor.getMonth() + 3);
  }

  while (cursor <= rangeEnd) {
    entries.push(...createTaskOccurrencesForDate(task, cursor));
    cursor.setMonth(cursor.getMonth() + 3);
  }

  return entries;
}

function getDateRangeBounds(range) {
  const today = startOfDay(new Date());
  const end = endOfDay(today);

  if (range === "last7") {
    return { start: startOfDay(subtractDays(today, 6)), end };
  }

  if (range === "last15") {
    return { start: startOfDay(subtractDays(today, 14)), end };
  }

  if (range === "thisMonth") {
    return { start: new Date(today.getFullYear(), today.getMonth(), 1), end };
  }

  if (range === "allTime") {
    return { start: new Date(0), end };
  }

  return { start: today, end };
}

function expandTaskForDateRange(task, range) {
  const bounds = getDateRangeBounds(range);
  const startDate = startOfDay(getTaskReferenceDate(task));
  const finalDate = startOfDay(new Date(`${task.validUntil}T00:00:00`));
  const rangeStart = bounds.start;
  const rangeEnd = bounds.end;

  if (startDate > rangeEnd || finalDate < rangeStart) {
    return [];
  }

  const cappedEnd = finalDate < rangeEnd ? finalDate : rangeEnd;
  const frequency = normalizeFrequency(task.frequency);

  if (frequency === "daily") {
    return buildDailyEntries(task, startDate, rangeStart, cappedEnd);
  }

  if (frequency === "weekly") {
    return buildWeeklyEntries(task, startDate, rangeStart, cappedEnd);
  }

  if (frequency === "every_15_days") {
    return buildEvery15DayEntries(task, startDate, rangeStart, cappedEnd);
  }

  if (frequency === "monthly") {
    return buildMonthlyEntries(task, startDate, rangeStart, cappedEnd);
  }

  if (frequency === "every_3_months") {
    return buildQuarterlyEntries(task, startDate, rangeStart, cappedEnd);
  }

  return startDate >= rangeStart && startDate <= cappedEnd ? [createTaskOccurrence(task, startDate)] : [];
}

// expandTaskForDateRange(task, "allTime") still bounds each task's own
// startDate at its CURRENT plannedDate (see buildDailyEntries), which gets
// bumped forward whenever a task is edited/reassigned — silently dropping
// historical rows for the dates before that bump unless a completion already
// exists there. Daily tasks are the ones this report needs a truly
// continuous range for, so they get their own expansion, floored at
// SUBMISSION_REPORT_START_DATE regardless of where the task's plannedDate
// has since drifted to.
const SUBMISSION_REPORT_START_DATE = "2026-07-22";

function buildContinuousDailyOccurrences(task, reportStartDateValue) {
  const taskStart = startOfDay(getTaskReferenceDate(task));
  const reportStart = startOfDay(new Date(`${reportStartDateValue}T00:00:00`));
  const effectiveStart = taskStart < reportStart ? taskStart : reportStart;
  const validUntil = startOfDay(new Date(`${task.validUntil}T00:00:00`));
  const cappedEnd = validUntil < startOfDay(new Date()) ? validUntil : startOfDay(new Date());

  if (effectiveStart > cappedEnd) {
    return [];
  }

  const entries = [];
  const cursor = new Date(effectiveStart);
  while (cursor <= cappedEnd) {
    entries.push(...createTaskOccurrencesForDate(task, cursor));
    cursor.setDate(cursor.getDate() + 1);
  }
  return entries;
}

// Every occurrence of every active task, from when each task started
// through today, matched against completions to show who's actually
// submitted vs still pending — the full audit for the Submissions Report
// sheet (not just an event log of what's been submitted so far).
function buildSubmissionAuditRows(tasks, completions) {
  const safeTasks = Array.isArray(tasks) ? tasks : [];
  const safeCompletions = completions && typeof completions === "object" ? completions : {};
  const rows = [];
  const seenKeys = new Set();

  safeTasks
    .filter((task) => task.active !== false)
    .map((task) => applyTaskScheduleOverrides(task))
    .forEach((task) => {
      const occurrences =
        normalizeFrequency(task.frequency) === "daily"
          ? buildContinuousDailyOccurrences(task, SUBMISSION_REPORT_START_DATE)
          : expandTaskForDateRange(task, "allTime");

      occurrences.forEach((occurrence) => {
        const key = getCompletionKey(occurrence);
        if (seenKeys.has(key)) {
          return;
        }
        seenKeys.add(key);
        const completion = safeCompletions[key];
        rows.push({
          assigneeName: occurrence.assigneeName,
          assigneeEmail: occurrence.assigneeEmail,
          taskTitle: getTaskDisplayTitle(occurrence),
          plannedDate: occurrence.occurrenceDate,
          submittedAt: completion ? completion.submittedAt : null,
        });
      });
    });

  // A task's plannedDate can get bumped forward when it's re-assigned/edited,
  // which can leave older completions outside the window computed above.
  // Union those back in so a real historical submission never disappears
  // from the report just because the task moved on since then.
  Object.entries(safeCompletions).forEach(([key, completion]) => {
    if (seenKeys.has(key)) {
      return;
    }
    const task = safeTasks.find((item) => String(item.taskId || item.id) === String(completion.taskId));
    if (!task) {
      return;
    }
    seenKeys.add(key);
    const slotLabel = completion.occurrenceSlotLabel || (completion.visitNumber ? `Visit ${completion.visitNumber}` : "");
    rows.push({
      assigneeName: task.assigneeName,
      assigneeEmail: task.assigneeEmail,
      taskTitle: slotLabel ? `${task.title} (${slotLabel})` : task.title,
      plannedDate: completion.occurrenceDate,
      submittedAt: completion.submittedAt,
    });
  });

  return rows.sort((left, right) => {
    if (left.plannedDate !== right.plannedDate) {
      return left.plannedDate < right.plannedDate ? -1 : 1;
    }
    return (left.assigneeName || "").localeCompare(right.assigneeName || "");
  });
}

module.exports = {
  buildSubmissionAuditRows,
};
