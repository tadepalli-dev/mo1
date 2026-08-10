// business.js — extracted from app.js (31 declarations)

function isPantryTask(task) {
  return normalizeTaskTitle(task?.title) === "pantry";
}


const SITE_VISIT_TASK_TITLES = ["site visit", "visit the 10 site"];

function isSiteVisitTask(task) {
  return SITE_VISIT_TASK_TITLES.includes(normalizeTaskTitle(task?.title));
}

function isGeneratorChecklistTask(task) {
  return normalizeTaskTitle(task?.title).includes("generator checklist");
}

function buildGeneratorChecklistTemplate(generatorUnit) {
  const baseTemplate = CHECKLIST_TEMPLATES["generator checklist"];
  if (!baseTemplate) {
    return buildDefaultChecklistTemplate({ title: "Generator checklist" });
  }

  const questions = [
    {
      id: "generator_no_selected",
      label: "Generator No",
      type: "text",
      value: generatorUnit,
      readOnly: true,
    },
    {
      id: "generator_no_photo",
      label: "Upload image for Generator No.",
      type: "photo",
      hint: "Take a photo with your phone camera, or upload one from your gallery.",
    },
    ...baseTemplate.questions.filter((question) => question.id !== "generator_no" && question.id !== "generator_no_photo"),
  ];

  return {
    title: baseTemplate.title,
    questions,
  };
}


function isCashHandlingChecklistTask(task) {
  return normalizeTaskTitle(task?.title) === "cash handling checklist";
}

const CASH_HANDLING_SHIFT_HINDI = Object.freeze({ Morning: "सुबह", Evening: "शाम" });

function buildCashHandlingChecklistTemplate(shift) {
  const baseTemplate = CHECKLIST_TEMPLATES["cash handling checklist"];
  if (!baseTemplate) {
    return buildDefaultChecklistTemplate({ title: "Cash handling checklist" });
  }

  const shiftHindi = CASH_HANDLING_SHIFT_HINDI[shift] || shift;

  const questions = [
    {
      id: "cash_handling_shift",
      label: "Shift",
      type: "text",
      value: shift,
      readOnly: true,
    },
    ...baseTemplate.questions.map((question) => {
      if (question.id === "cash_locker_safety") {
        return {
          ...question,
          label: `Is the ${shift} cash locker locked safely?`,
          labelHindi: `क्या ${shiftHindi} कैश लॉकर सुरक्षित रूप से बंद है?`,
        };
      }
      if (question.id === "cash_locker_photo") {
        return {
          ...question,
          label: `Upload image of the ${shift} cash locker.`,
          labelHindi: `${shiftHindi} कैश लॉकर की फोटो अपलोड करें।`,
        };
      }
      return question;
    }),
  ];

  return {
    title: baseTemplate.title,
    questions,
  };
}


function isMeterReadingChecklistTask(task) {
  return normalizeTaskTitle(task?.title).includes("meter reading");
}

function buildMeterReadingChecklistTemplate(location) {
  const baseTemplate = CHECKLIST_TEMPLATES["meter reading in both mo1 and mo2"];
  if (!baseTemplate) {
    return buildDefaultChecklistTemplate({ title: "Meter reading checklist" });
  }

  const questions = [
    {
      id: "meter_reading_location",
      label: "Location",
      type: "text",
      value: location,
      readOnly: true,
    },
    ...baseTemplate.questions.map((question) => {
      if (question.id === "kvah_meter_reading") {
        return { ...question, label: `What is the ${location} KVAH meter reading?`, labelHindi: `${location} KVAH मीटर रीडिंग क्या है?` };
      }
      if (question.id === "kvah_meter_photo") {
        return { ...question, label: `Upload image of the ${location} KVAH meter reading.`, labelHindi: `${location} KVAH मीटर रीडिंग की फोटो अपलोड करें।` };
      }
      if (question.id === "kwah_meter_reading") {
        return { ...question, label: `What is the ${location} KWAH meter reading?`, labelHindi: `${location} KWAH मीटर रीडिंग क्या है?` };
      }
      if (question.id === "kwah_meter_photo") {
        return { ...question, label: `Upload image of the ${location} KWAH meter reading.`, labelHindi: `${location} KWAH मीटर रीडिंग की फोटो अपलोड करें।` };
      }
      return question;
    }),
  ];

  return {
    title: baseTemplate.title,
    questions,
  };
}


function isEarthingCleaningTask(task) {
  return normalizeTaskTitle(task?.title).includes("earthing and cleaning");
}

function buildEarthingCleaningChecklistTemplate(location) {
  const baseTemplate = CHECKLIST_TEMPLATES["earthing and cleaning once in a month"];
  if (!baseTemplate) {
    return buildDefaultChecklistTemplate({ title: "Earthing and cleaning checklist" });
  }

  const questions = [
    {
      id: "earthing_cleaning_location",
      label: "Location",
      type: "text",
      value: location,
      readOnly: true,
    },
    ...baseTemplate.questions.map((question) => {
      if (question.id === "earth_recharge_done") {
        return { ...question, label: `Is the ${location} earth recharge done?`, labelHindi: `क्या ${location} अर्थ रिचार्ज किया गया है?` };
      }
      if (question.id === "earth_recharge_photo") {
        return { ...question, label: `Upload image of the ${location} earth recharge.`, labelHindi: `${location} अर्थ रिचार्ज की फोटो अपलोड करें।` };
      }
      return question;
    }),
  ];

  return {
    title: baseTemplate.title,
    questions,
  };
}


function requiresKamalPreApproval(task) {
  return (
    normalizeTaskTitle(task?.title).includes("ac filter cleaning") &&
    task?.assigneeEmail?.toLowerCase() === "arunmishra@modesigns.in"
  );
}

function getPendingKamalApprovalEntries() {
  return Object.entries(state.completions)
    .filter(([, completion]) => completion.kamalApprovalStatus === "pending")
    .map(([key, completion]) => {
      const task = state.tasks.find((item) => String(item.taskId || item.id) === String(completion.taskId));
      return task ? { key, completion, task } : null;
    })
    .filter(Boolean)
    .sort((left, right) => new Date(right.completion.submittedAt) - new Date(left.completion.submittedAt));
}


function getFilteredUsers() {
  return state.users.filter((user) => {
    const searchable = `${user.name} ${user.email} ${user.role} ${user.designation} ${user.code} ${user.dayOff}`.toLowerCase();
    const matchesQuery = !state.query || searchable.includes(state.query);
    const matchesRole = state.role === "all" || normalizeValue(user.role) === state.role;
    const matchesDayOff = state.dayOff === "all" || normalizeValue(user.dayOff) === state.dayOff;
    return matchesQuery && matchesRole && matchesDayOff;
  });
}


function groupAdminTasksByAssignee(tasks) {
  const groups = new Map();

  tasks.forEach((task) => {
    const key = task.assigneeEmail?.toLowerCase() || task.assigneeName.toLowerCase();
    if (!groups.has(key)) {
      groups.set(key, {
        assigneeName: task.assigneeName,
        department: task.department,
        starts: task.plannedDate,
        activeUntil: task.validUntil,
        tasks: [],
      });
    }

    const group = groups.get(key);
    group.tasks.push(task);
    if (task.plannedDate < group.starts) {
      group.starts = task.plannedDate;
    }
    if (task.validUntil > group.activeUntil) {
      group.activeUntil = task.validUntil;
    }
  });

  return [...groups.values()].sort((left, right) =>
    left.assigneeName.localeCompare(right.assigneeName)
  );
}


function mapOccurrenceForViewer(occurrence, viewer) {
  if (isTaskAssignedToUser(occurrence, viewer)) {
    return occurrence;
  }

  const coverage = getCoverageForOccurrence(occurrence, occurrence.occurrenceDate);
  if (coverage) {
    const isBuddyViewer = coverage.buddies.some((buddy) =>
      isBuddyMatchForUser(buddy, coverage.department, viewer)
    );
    if (!isBuddyViewer) {
      return null;
    }

    return {
      ...occurrence,
      coverageReason: coverage.type,
      coverageSourceName: occurrence.assigneeName,
    };
  }

  return null;
}


function getCoverageForOccurrence(task, dateValue) {
  const department = findBuddyRecordByEmployee(task.assigneeName)?.department || "-";

  const absence = getAbsenceRecord(task.assigneeName, dateValue);
  if (absence) {
    const buddies = getBuddyTargets(task.assigneeName);
    if (!buddies.length) {
      return null;
    }
    return {
      type: absence.reason,
      buddies,
      department,
    };
  }

  const sheetLeave = findSheetLeaveForEmployee(task.assigneeName, dateValue);
  if (sheetLeave) {
    const buddies = getBuddyTargets(task.assigneeName);
    if (!buddies.length) {
      return null;
    }
    return {
      type: sheetLeave.reason,
      buddies,
      department,
    };
  }

  const buddyRecord = findBuddyRecordByEmployee(task.assigneeName);
  if (buddyRecord && normalizeWeekDay(buddyRecord.weekOff) === normalizeWeekDay(getDayNameFromDate(dateValue))) {
    if (!buddyRecord.buddies.length) {
      return null;
    }
    return {
      type: "Week Off",
      buddies: buddyRecord.buddies,
      department: buddyRecord.department,
    };
  }

  return null;
}


function buildCoverageOccurrencesForDate(dateValue) {
  return state.tasks
    .filter((task) => task.active !== false && isTaskActiveOnDate(task, dateValue))
    .map((task) => createTaskOccurrence(task, new Date(`${dateValue}T00:00:00`)))
    .filter((occurrence) => getCoverageForOccurrence(occurrence, dateValue));
}


function getCoverageEntriesForDate(dateValue) {
  const entries = [];
  const weekDay = normalizeWeekDay(getDayNameFromDate(dateValue));
  const claimed = new Set();

  Object.values(state.absences).forEach((item) => {
    if (item.date === dateValue) {
      claimed.add(normalizePersonName(item.employee));
      entries.push({
        employee: item.employee,
        department: findBuddyRecordByEmployee(item.employee)?.department || "-",
        date: item.date,
        type: item.reason,
        buddies: getBuddyTargets(item.employee),
        source: "manual",
      });
    }
  });

  getSheetLeavesForDate(dateValue).forEach((item) => {
    const key = normalizePersonName(item.employeeName);
    if (claimed.has(key)) {
      return;
    }
    claimed.add(key);
    entries.push({
      employee: item.employeeName,
      department: findBuddyRecordByEmployee(item.employeeName)?.department || "-",
      date: dateValue,
      type: item.reason,
      buddies: getBuddyTargets(item.employeeName),
      source: "sheet",
    });
  });

  BUDDY_ASSIGNMENTS.forEach((item) => {
    if (claimed.has(normalizePersonName(item.employee))) {
      return;
    }
    if (normalizeWeekDay(item.weekOff) === weekDay) {
      entries.push({
        employee: item.employee,
        department: item.department,
        date: dateValue,
        type: "Week Off",
        buddies: item.buddies,
        source: "weekoff",
      });
    }
  });

  return entries;
}


function getSheetLeavesForDate(dateValue) {
  const latestByEmployee = new Map();
  state.sheetLeaves.forEach((item) => {
    if (dateValue >= item.startDate && dateValue <= item.endDate) {
      latestByEmployee.set(normalizePersonName(item.employeeName), item);
    }
  });
  return [...latestByEmployee.values()];
}


function findSheetLeaveForEmployee(employeeName, dateValue) {
  return (
    state.sheetLeaves.find(
      (item) =>
        matchesPersonName(item.employeeName, employeeName) &&
        dateValue >= item.startDate &&
        dateValue <= item.endDate
    ) || null
  );
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


function createTaskOccurrence(task, date, extra = {}) {
  const isWeekly = normalizeFrequency(task.frequency) === "weekly";
  const occurrenceBaseDate = isWeekly ? getStartOfWeek(new Date(date)) : new Date(date);
  return {
    ...task,
    ...extra,
    occurrenceDate: dateToLocalValue(occurrenceBaseDate),
  };
}


function taskOccursOnDate(task, dateValue) {
  return expandTaskForDateRange(task, "thisMonth").some((occurrence) => occurrence.occurrenceDate === dateValue)
    || isTaskActiveOnDate(task, dateValue);
}


function isTaskActiveOnDate(task, dateValue) {
  const targetDate = startOfDay(new Date(`${dateValue}T00:00:00`));
  const startDate = startOfDay(new Date(`${task.plannedDate}T00:00:00`));
  const endDate = startOfDay(new Date(`${task.validUntil}T00:00:00`));

  if (targetDate < startDate || targetDate > endDate) {
    return false;
  }

  const frequency = normalizeFrequency(task.frequency);
  if (frequency === "one_time") {
    return targetDate.getTime() === startDate.getTime();
  }

  if (frequency === "daily") {
    return true;
  }

  if (frequency === "weekly") {
    return true;
  }

  if (frequency === "every_15_days") {
    return diffInDays(startDate, targetDate) % 15 === 0;
  }

  if (frequency === "monthly") {
    return startDate.getDate() === targetDate.getDate();
  }

  if (frequency === "every_3_months") {
    if (startDate.getDate() !== targetDate.getDate()) {
      return false;
    }
    const monthsElapsed =
      (targetDate.getFullYear() - startDate.getFullYear()) * 12 + (targetDate.getMonth() - startDate.getMonth());
    return monthsElapsed % 3 === 0;
  }

  return false;
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


// Every occurrence of every active task, from when each task started
// through today, matched against state.completions to show who's actually
// submitted vs still pending — the full audit for the Submissions Report
// sheet (not just an event log of what's been submitted so far).
function buildSubmissionAuditRows() {
  const rows = [];
  const seenKeys = new Set();

  state.tasks
    .filter((task) => task.active !== false)
    .forEach((task) => {
      expandTaskForDateRange(task, "allTime").forEach((occurrence) => {
        const key = getCompletionKey(occurrence);
        if (seenKeys.has(key)) {
          return;
        }
        seenKeys.add(key);
        const completion = state.completions[key];
        rows.push({
          assigneeName: occurrence.assigneeName,
          assigneeEmail: occurrence.assigneeEmail,
          taskTitle: getTaskDisplayTitle(occurrence),
          plannedDate: occurrence.occurrenceDate,
          submittedAt: completion ? completion.submittedAt : null,
        });
      });
    });

  // A task's plannedDate can get bumped forward when it's re-assigned/edited
  // (DEFAULT_TASK_START_DATE tracks "today"), which can leave older
  // completions outside the [plannedDate, today] window computed above.
  // Union those back in so a real historical submission never disappears
  // from the report just because the task moved on since then.
  Object.entries(state.completions).forEach(([key, completion]) => {
    if (seenKeys.has(key)) {
      return;
    }
    const task = state.tasks.find((item) => String(item.taskId || item.id) === String(completion.taskId));
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


function getCompletionRecord(task) {
  return state.completions[getCompletionKey(task)] || null;
}


function getTaskCompletionHistory(task) {
  const taskId = String(task.taskId || task.id);
  return Object.values(state.completions)
    .filter((completion) => String(completion.taskId) === taskId && !completion.visitNumber)
    .sort((left, right) => {
      const leftDate = left.occurrenceDate || toDateValue(left.submittedAt);
      const rightDate = right.occurrenceDate || toDateValue(right.submittedAt);
      return rightDate.localeCompare(leftDate);
    });
}


function getNextEligibleCompletionDate(task) {
  if (!isArunMishraTask(task) || !isAcFilterCleaningTask(task)) {
    return task.plannedDate;
  }

  const latestCompletion = getTaskCompletionHistory(task)[0];
  if (!latestCompletion) {
    return task.plannedDate;
  }

  const latestDate = latestCompletion.occurrenceDate || toDateValue(latestCompletion.submittedAt);
  return addDaysToDateValue(latestDate, 15);
}


function getTaskAvailability(task) {
  const occurrenceDate = task.occurrenceDate || task.plannedDate || todayValue();
  if (!isArunMishraTask(task) || !isAcFilterCleaningTask(task)) {
    return {
      enabled: true,
      label: "Task completed",
      reason: "",
    };
  }

  const nextEligibleDate = getNextEligibleCompletionDate(task);
  if (occurrenceDate < nextEligibleDate) {
    return {
      enabled: false,
      label: `Available ${formatDateValue(nextEligibleDate)}`,
      reason: `This task unlocks again on ${formatDateValue(nextEligibleDate)}.`,
    };
  }

  return {
    enabled: true,
    label: "Task completed",
    reason: "",
  };
}


function shouldTaskRequireSubmission(task) {
  return isTaskCompletionEnabled(task) && !getCompletionRecord(task);
}


function isTaskCompletionEnabled(task) {
  return getTaskAvailability(task).enabled;
}


function getChecklistTemplate(task) {
  const title = normalizeTaskTitle(task.title);
  const sanitizedTitle = title.replace(/[^\w\s]+/g, "").trim();
  const singular = title.endsWith("s") ? title.slice(0, -1) : title;
  const plural = title.endsWith("s") ? title : `${title}s`;
  const sanitizedSingular = sanitizedTitle.endsWith("s") ? sanitizedTitle.slice(0, -1) : sanitizedTitle;
  const sanitizedPlural = sanitizedTitle.endsWith("s") ? sanitizedTitle : `${sanitizedTitle}s`;
  const matched =
    CHECKLIST_TEMPLATES[title]
    || CHECKLIST_TEMPLATES[singular]
    || CHECKLIST_TEMPLATES[plural]
    || CHECKLIST_TEMPLATES[sanitizedTitle]
    || CHECKLIST_TEMPLATES[sanitizedSingular]
    || CHECKLIST_TEMPLATES[sanitizedPlural];
  if (matched) {
    return matched;
  }
  return buildDefaultChecklistTemplate(task);
}


function buildDefaultChecklistTemplate(task) {
  const question = buildQuestionFromTaskTitle(task.title);
  return {
    title: "TASK CHECKLIST",
    questions: [
      {
        id: "completion_notes",
        label: question.label,
        labelHindi: question.labelHindi,
        type: "textarea",
      },
      {
        id: "supporting_files",
        label: "Upload supporting files if needed.",
        labelHindi: "यदि आवश्यक हो तो सहायक फ़ाइलें अपलोड करें।",
        type: "file",
        hint: "Upload up to 10 supported files. Max 100 MB per file.",
      },
    ],
  };
}


function buildQuestionFromTaskTitle(title) {
  const cleanTitle = String(title || "").trim();
  const verbMatch = cleanTitle.match(
    /^(send|check|share|confirm|verify|update|report|upload|provide|prepare|submit)\s+/i
  );
  let rest = verbMatch ? cleanTitle.slice(verbMatch[0].length) : cleanTitle;
  rest = rest ? rest.charAt(0).toLowerCase() + rest.slice(1) : cleanTitle;
  const needsArticle = rest && !/^(the|a|an|all|your|my|our)\b/i.test(rest);
  const phrase = (needsArticle ? `the ${rest}` : rest).replace(/[?.]+$/, "");
  return {
    label: `Can you share ${phrase}?`,
    labelHindi: `क्या आप साझा कर सकते हैं: ${phrase}?`,
  };
}


function getUniqueBuddyEmployees() {
  return [...new Set(BUDDY_ASSIGNMENTS.map((item) => item.employee))].sort((left, right) =>
    left.localeCompare(right)
  );
}


function findBuddyRecordByEmployee(name) {
  const key = normalizePersonName(name);
  const exact = BUDDY_ASSIGNMENTS.find((item) => normalizePersonName(item.employee) === key);
  if (exact) {
    return exact;
  }
  return BUDDY_ASSIGNMENTS.find((item) => matchesPersonName(item.employee, name)) || null;
}


function getBuddyTargets(name) {
  // Prefer an exact name match over a fuzzy one so two different employees
  // who share a first name (e.g. "Sanjay" vs "Sanjay Yadav") don't get their
  // buddy records merged or confused with one another.
  const key = normalizePersonName(name);
  const exactMatches = BUDDY_ASSIGNMENTS.filter((item) => normalizePersonName(item.employee) === key);
  const matches = exactMatches.length
    ? exactMatches
    : BUDDY_ASSIGNMENTS.filter((item) => matchesPersonName(item.employee, name));
  return matches.flatMap((item) => item.buddies).filter(Boolean);
}


function getAbsenceRecord(employee, dateValue) {
  return state.absences[getAbsenceKey(employee, dateValue)] || null;
}


function isBuddyMatchForUser(buddyName, department, user) {
  const buddyKey = normalizePersonName(buddyName);
  const userKey = normalizePersonName(user.name);
  if (buddyKey === userKey) {
    return true;
  }

  // Fuzzy (partial-name) matches are unreliable when two different real
  // employees share a first name (e.g. "Sanjay" the installer vs "Sanjay
  // Yadav" the driver). As a guard, only accept a fuzzy match when the
  // viewer's own role/designation is plausibly compatible with the
  // department of the person they'd be covering for. Departments we can't
  // confidently cross-reference fall back to allowing the match, so this
  // only tightens the cases we can actually verify.
  if (!isDepartmentCompatibleWithUser(department, user)) {
    return false;
  }

  return matchesPersonName(buddyName, user.name);
}


function isDepartmentCompatibleWithUser(department, user) {
  const dept = String(department || "").toLowerCase();
  const roleText = `${user.role || ""} ${user.designation || ""}`.toLowerCase();

  if (dept.includes("driver") && !roleText.includes("driver")) {
    return false;
  }

  return true;
}


function resolveTaskAssignee(value) {
  const normalizedValue = String(value || "").trim().toLowerCase();
  if (!normalizedValue) {
    return null;
  }

  return (
    state.users.find((user) => formatTaskAssigneeOption(user).toLowerCase() === normalizedValue) ||
    state.users.find((user) => user.email.toLowerCase() === normalizedValue) ||
    state.users.find((user) => user.name.toLowerCase() === normalizedValue)
  );
}


function countByRole(role) {
  return state.users.filter((user) => normalizeValue(user.role).toLowerCase() === role.toLowerCase()).length;
}


function getUniqueValues(key) {
  return [...new Set(state.users.map((user) => normalizeValue(user[key])))]
    .filter(Boolean)
    .sort((left, right) => left.localeCompare(right));
}
