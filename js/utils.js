// utils.js — extracted from app.js (33 declarations)

function getInitialView() {
  const hash = window.location.hash.replace("#", "").toLowerCase();
  if (hash === "users") {
    return "users";
  }
  if (hash === "approvals") {
    return "approvals";
  }
  if (hash === "compliance") {
    return "compliance";
  }
  if (hash === "buddy") {
    return "buddy";
  }
  if (hash === "contacts") {
    return "contacts";
  }
  return "home";
}

function getApiBaseUrl() {
  const override = localStorage.getItem("motrack-api-base");
  // A development override can remain in a browser after localhost testing.
  // Production must always call its own /api routes, otherwise the login page
  // appears offline even while the deployed API is healthy.
  const isLocalDevelopment = ["localhost", "127.0.0.1"].includes(window.location.hostname);
  if (isLocalDevelopment && override && override.trim()) {
    return override.trim().replace(/\/+$/, "");
  }

  return "";
}

function buildApiUrl(path) {
  const normalizedPath = String(path || "").startsWith("/") ? path : `/${path}`;
  return `${getApiBaseUrl()}${normalizedPath}`;
}


function calculateValidUntil(plannedDate, frequency) {
  if (normalizeFrequency(frequency) === "one_time") {
    return plannedDate;
  }

  const startDate = new Date(`${plannedDate}T00:00:00`);
  startDate.setFullYear(startDate.getFullYear() + 1);
  startDate.setDate(startDate.getDate() - 1);
  return dateToLocalValue(startDate);
}


function normalizePlannedDate(value) {
  const candidate = value || DEFAULT_TASK_START_DATE;
  return candidate < todayValue() ? todayValue() : candidate;
}


function getCompletionKey(task) {
  const slotKey = task.occurrenceSlot ? `__${task.occurrenceSlot}` : "";
  const customerKey = task.customerAttributionKey ? `__cust_${task.customerAttributionKey}` : "";
  return `${task.taskId || task.id}__${task.occurrenceDate}${slotKey}${customerKey}`;
}


function getVisitCompletionKey(task, visitNumber) {
  return `${getCompletionKey(task)}__visit${visitNumber}`;
}

function getGeneratorCompletionKey(task, generatorUnit) {
  return `${getCompletionKey(task)}__generator__${normalizePersonName(generatorUnit)}`;
}


function getCashHandlingCompletionKey(task, shift) {
  return `${getCompletionKey(task)}__cashshift__${normalizePersonName(shift)}`;
}


function getMeterReadingCompletionKey(task, location) {
  return `${getCompletionKey(task)}__meterlocation__${normalizePersonName(location)}`;
}


function getEarthingCleaningCompletionKey(task, location) {
  return `${getCompletionKey(task)}__earthinglocation__${normalizePersonName(location)}`;
}


function getAbsenceKey(employee, dateValue) {
  return `${normalizePersonName(employee)}__${dateValue}`;
}


function matchesPersonName(left, right) {
  const leftKey = normalizePersonName(left);
  const rightKey = normalizePersonName(right);

  return (
    leftKey === rightKey ||
    leftKey.includes(rightKey) ||
    rightKey.includes(leftKey)
  );
}


function normalizePersonName(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
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


function isKamalPrasadamTask(task) {
  return normalizePersonName(task?.assigneeName) === "kamal"
    && normalizeTaskTitle(task?.title).includes("distributed the prasadam on tuesday");
}


function getNextTuesdayValue() {
  const date = new Date(`${todayValue()}T00:00:00`);
  const daysUntilTuesday = (2 - date.getDay() + 7) % 7;
  date.setDate(date.getDate() + daysUntilTuesday);
  return dateToLocalValue(date);
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
  if (isKamalPrasadamTask(task)) {
    // The old record was created as a daily Thursday task. Anchor every new
    // occurrence to Tuesday so it never appears on any other weekday.
    overrides.frequency = "weekly";
    overrides.displayFrequency = "weekly";
    overrides.plannedDate = getNextTuesdayValue();
  }

  return Object.keys(overrides).length ? { ...task, ...overrides } : task;
}


function getTaskDisplayFrequency(task) {
  return normalizeFrequency(task?.displayFrequency || task?.frequency);
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


function normalizeCompactPersonName(value) {
  return normalizePersonName(value).replace(/\s+/g, "");
}


function isTaskAssignedToUser(task, user) {
  if (!task || !user) {
    return false;
  }

  // Once a task has an assigneeEmail on file, it's decisive — two people can
  // share a display name (e.g. two employees both named "Pradeep"), so only
  // fall back to matching by name for older tasks that never had an email
  // recorded at all. Falling through on a same-name-different-email task
  // would attribute one person's tasks to the other.
  const taskEmail = String(task.assigneeEmail || "").trim().toLowerCase();
  const userEmail = String(user.email || "").trim().toLowerCase();
  if (taskEmail && userEmail) {
    return taskEmail === userEmail;
  }

  const taskName = normalizePersonName(task.assigneeName);
  const userName = normalizePersonName(user.name);
  if (taskName && userName && taskName === userName) {
    return true;
  }

  const compactTaskName = normalizeCompactPersonName(task.assigneeName);
  const compactUserName = normalizeCompactPersonName(user.name);
  return Boolean(compactTaskName && compactUserName && compactTaskName === compactUserName);
}


function getDayNameFromDate(dateValue) {
  return new Intl.DateTimeFormat("en-US", { weekday: "long" }).format(
    new Date(`${dateValue}T00:00:00`)
  );
}


function normalizeWeekDay(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}


function formatTaskAssigneeOption(user) {
  return `${user.name} (${user.role}) - ${user.email}`;
}


function subtractDays(date, days) {
  const nextDate = new Date(date);
  nextDate.setDate(nextDate.getDate() - days);
  return nextDate;
}


function diffInDays(left, right) {
  return Math.floor((right.getTime() - left.getTime()) / 86400000);
}


function createTaskCode(user) {
  const base = user.name.replace(/[^a-z0-9]/gi, "").toUpperCase().slice(0, 4) || "TASK";
  const stamp = Date.now().toString().slice(-6);
  return `${base}-${stamp}`;
}


function normalizeTaskTitle(value) {
  return String(value || "").trim().toLowerCase();
}


function getFrequencyLabel(frequency) {
  const labels = {
    daily: "Daily",
    weekly: "Weekly",
    every_15_days: "Every 15 days",
    monthly: "Monthly",
    every_3_months: "Every 3 months",
    one_time: "One time",
  };
  return labels[normalizeFrequency(frequency)] ?? "Task";
}


function getFrequencyShortLabel(frequency) {
  const labels = {
    daily: "D",
    weekly: "W",
    every_15_days: "15D",
    monthly: "M",
    every_3_months: "3M",
    one_time: "O",
  };
  return labels[normalizeFrequency(frequency)] ?? "T";
}


function normalizeFrequency(value) {
  return (value || "one_time").toLowerCase();
}


function getDepartmentLabel(user) {
  return normalizeValue(user.designation) !== "-" ? normalizeValue(user.designation) : normalizeValue(user.role);
}


function formatDateValue(value) {
  if (!value) {
    return "-";
  }

  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(`${value}T00:00:00`));
}


function formatTaskDate(task) {
  const dateLabel = task.occurrenceDate
    ? formatDateValue(task.occurrenceDate)
    : formatDateValue(task.plannedDate);
  return task.occurrenceSlotLabel ? `${dateLabel} | ${task.occurrenceSlotLabel}` : dateLabel;
}

function getTaskOccurrenceIdentity(task) {
  const slotKey = task.occurrenceSlot ? `__${task.occurrenceSlot}` : "";
  const customerKey = task.customerAttributionKey ? `__cust_${task.customerAttributionKey}` : "";
  return `${task.taskId || task.id}__${task.occurrenceDate || task.plannedDate || ""}${slotKey}${customerKey}`;
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


// Tasks without a sequence sort after any that have one, keeping their
// relative order (stable sort) instead of interleaving with sequenced tasks.
function getTaskSequenceValue(task) {
  return Number.isFinite(task.sequence) ? task.sequence : Infinity;
}


function toDateValue(value) {
  if (!value) {
    return "";
  }
  return dateToLocalValue(new Date(value));
}


function dateToLocalValue(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}


function addDaysToDateValue(value, days) {
  const date = new Date(`${value}T00:00:00`);
  date.setDate(date.getDate() + days);
  return dateToLocalValue(date);
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


function getDashboardSubtitle(user) {
  if (canAssignTasks(user)) {
    return "Search your task board, choose a date, and assign work directly to team members.";
  }
  if (canMonitorChecklists(user)) {
    return "Monitor who submitted checklists, who missed them, and what was filled in for each submission.";
  }
  if (isAdmin(user)) {
    return "Review the latest assigned work and track activity from your MoTrack dashboard.";
  }
  return "See the checklist tasks assigned to you and submit the completion form when your work is done.";
}


function todayValue() {
  return dateToLocalValue(new Date());
}


function normalizeValue(value) {
  return value && value !== "-" ? value : "-";
}


function isAdmin(user) {
  return normalizeValue(user?.role).toLowerCase() === "admin";
}

function isVehicleHrApprover(user) {
  return String(user?.email || "").trim().toLowerCase() === "kamal@modesigns.in";
}

function isVehicleCashier(user) {
  return String(user?.email || "").trim().toLowerCase() === "dilip.gupta@curtainsandcarpets.com";
}

// Requests raised before the two desks swapped order carry the old status
// names; both meant "no vehicle allocated yet", which is now Kamal's step.
function normalizeVehicleRequestStatus(status) {
  const value = String(status || "").trim();
  if (value === "pending_cashier" || value === "pending_hr") {
    return "pending_allocation";
  }
  return value;
}

function isVehicleRequestOpen(entry) {
  return ["pending_allocation", "pending_cash"].includes(normalizeVehicleRequestStatus(entry?.status));
}


function isPcMonitorUser(user) {
  const role = normalizeValue(user?.role).toLowerCase();
  const designation = normalizeValue(user?.designation).toLowerCase();
  return role === "pc" || designation === "pc";
}


function canManageUsers(user) {
  return isAdmin(user);
}


function canAssignTasks(user) {
  return isAdmin(user) && normalizeValue(user?.designation).toLowerCase().includes("ea");
}


function canMonitorChecklists(user) {
  return canAssignTasks(user) || isPcMonitorUser(user);
}


function getDefaultViewForUser(user) {
  return "home";
}


function isChildCompletionRecord(completionKey) {
  const key = String(completionKey || "");
  return (
    key.includes("__visit") ||
    key.includes("__generator__") ||
    key.includes("__cashshift__") ||
    key.includes("__meterlocation__") ||
    key.includes("__earthinglocation__")
  );
}


function isMonitorableCompletionRecord(completionKey, completion) {
  return Boolean(completion) && !isChildCompletionRecord(completionKey);
}


function getLatestMonitorableCompletionDate() {
  if (!state?.completions || typeof state.completions !== "object") {
    return "";
  }

  return Object.entries(state.completions)
    .filter(([key, completion]) => isMonitorableCompletionRecord(key, completion))
    .map(([, completion]) => completion.occurrenceDate || toDateValue(completion.submittedAt))
    .filter(Boolean)
    .sort((left, right) => right.localeCompare(left))[0] || "";
}


function getDefaultApprovalsDateForUser(user) {
  return todayValue();
}


function formatDateTimeValue(value) {
  if (!value) {
    return "-";
  }

  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}


function setStatusMessage(element, text, status) {
  element.textContent = text;
  element.classList.remove("is-error", "is-success");
  if (status) {
    element.classList.add(`is-${status}`);
  }
}


function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}


// Wires a mic button to a textarea using the browser's built-in speech
// recognition (Chrome/Edge only — no server-side transcription involved).
// Spoken words are typed into the field live; each finalized phrase is kept,
// with the in-progress phrase shown until it's finalized or corrected.
function setupVoiceInput(button, textarea, statusElement) {
  if (!button || !textarea) {
    return;
  }

  const SpeechRecognitionCtor = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognitionCtor) {
    button.disabled = true;
    button.title = "Voice input isn't supported in this browser.";
    if (statusElement) {
      statusElement.textContent = "Voice input isn't supported in this browser — try Chrome or Edge.";
    }
    return;
  }

  const recognizer = new SpeechRecognitionCtor();
  recognizer.continuous = true;
  recognizer.interimResults = true;
  recognizer.lang = "en-IN";

  let isRecording = false;
  let baseText = "";

  const setRecordingState = (recording) => {
    isRecording = recording;
    button.classList.toggle("is-recording", recording);
    button.setAttribute("aria-label", recording ? "Stop recording" : "Record a voice note");
    if (statusElement) {
      statusElement.textContent = recording ? "Listening… speak now." : "";
    }
  };

  recognizer.onresult = (event) => {
    let interim = "";
    let final = "";
    for (let i = event.resultIndex; i < event.results.length; i += 1) {
      const transcript = event.results[i][0].transcript;
      if (event.results[i].isFinal) {
        final += transcript;
      } else {
        interim += transcript;
      }
    }
    if (final) {
      baseText = `${baseText}${baseText && !baseText.endsWith(" ") ? " " : ""}${final.trim()} `;
    }
    textarea.value = `${baseText}${interim}`;
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  };

  recognizer.onerror = (event) => {
    setRecordingState(false);
    if (statusElement && event.error !== "aborted") {
      statusElement.textContent = "Couldn't access the microphone. Check browser permissions and try again.";
    }
  };

  recognizer.onend = () => {
    setRecordingState(false);
  };

  button.addEventListener("click", () => {
    if (isRecording) {
      recognizer.stop();
      return;
    }
    baseText = textarea.value.trim() ? `${textarea.value.trim()} ` : "";
    try {
      recognizer.start();
      setRecordingState(true);
    } catch (error) {
      // start() throws if a recognition session is already active elsewhere
      // in the page — safe to ignore, the existing session keeps running.
    }
  });
}


// fetch().json() throws a parser error when the server replies with something
// that isn't JSON at all - the static "Not found" page when a route is missing,
// an HTML error page from a proxy, or an empty body from a crashed handler.
// That parser error tells the user nothing, so read the body as text first and
// turn anything unparseable into a message that names the real problem.
async function readJsonResponse(response) {
  const raw = await response.text();
  try {
    return JSON.parse(raw);
  } catch (error) {
    if (response.status === 404) {
      throw new Error(
        "This action isn't available on the server yet (404). The server is most likely running an older build - restart it and try again."
      );
    }
    const detail = raw.trim().slice(0, 120);
    throw new Error(
      `The server returned an unexpected response (${response.status})${detail ? `: ${detail}` : "."}`
    );
  }
}


// Phone cameras hand us 3-8 MB JPEGs, well past the 3 MB attachment cap, and
// employees have no practical way to shrink a photo by hand. Everything below
// re-encodes an oversized image in the browser before it is ever uploaded.
const IMAGE_COMPRESSION_TARGET_BYTES = 900 * 1024;
const IMAGE_COMPRESSION_MAX_DIMENSION = 1920;
const IMAGE_COMPRESSION_QUALITY_STEPS = [0.82, 0.7, 0.6, 0.5, 0.4];

// GIFs would lose their animation and SVGs have no meaningful pixel size, so
// neither is worth rasterising — everything else raster we can re-encode.
function isCompressibleImage(file) {
  const type = String(file?.type || "").toLowerCase();
  return type.startsWith("image/") && type !== "image/gif" && type !== "image/svg+xml";
}

function formatFileSize(bytes) {
  const size = Number(bytes) || 0;
  if (size >= 1024 * 1024) {
    return `${(size / (1024 * 1024)).toFixed(1)} MB`;
  }
  if (size >= 1024) {
    return `${Math.round(size / 1024)} KB`;
  }
  return `${size} B`;
}

function toJpegFileName(name) {
  const base = String(name || "photo").replace(/\.[a-z0-9]+$/i, "");
  return `${base || "photo"}.jpg`;
}

function canvasToBlob(canvas, type, quality) {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

async function decodeImageFile(file) {
  if (typeof createImageBitmap === "function") {
    try {
      // "from-image" applies the EXIF rotation phones record, so portrait
      // photos don't come out sideways once they're redrawn to a canvas.
      return await createImageBitmap(file, { imageOrientation: "from-image" });
    } catch (error) {
      // Older engines reject the options bag outright — retry without it.
    }
    try {
      return await createImageBitmap(file);
    } catch (error) {
      // Format the decoder can't handle (HEIC on most browsers) — fall back.
    }
  }

  return new Promise((resolve, reject) => {
    const objectUrl = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(objectUrl);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error("Could not decode the selected image."));
    };
    image.src = objectUrl;
  });
}

// Returns a smaller JPEG File, or the original file untouched when it is
// already small enough, isn't an image, or can't be decoded. Never throws for
// an undecodable file — an upload that skips compression still beats a
// checklist that refuses to submit.
async function compressImageFile(file, options = {}) {
  const targetBytes = options.targetBytes || IMAGE_COMPRESSION_TARGET_BYTES;
  const maxDimension = options.maxDimension || IMAGE_COMPRESSION_MAX_DIMENSION;

  if (!file || !isCompressibleImage(file)) {
    return file;
  }

  let source;
  try {
    source = await decodeImageFile(file);
  } catch (error) {
    return file;
  }

  const width = source.width || source.naturalWidth;
  const height = source.height || source.naturalHeight;
  if (!width || !height) {
    source.close?.();
    return file;
  }

  if (file.size <= targetBytes && Math.max(width, height) <= maxDimension) {
    source.close?.();
    return file;
  }

  let scale = Math.min(1, maxDimension / Math.max(width, height));
  let best = null;

  // Quality alone can't always reach the target for a very large photo, so
  // each pass that falls short redraws at 70% of the previous size.
  for (let pass = 0; pass < 3 && !(best && best.size <= targetBytes); pass += 1) {
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));

    const context = canvas.getContext("2d");
    // JPEG has no alpha channel — flatten onto white so transparent PNG
    // screenshots don't turn into black rectangles.
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(source, 0, 0, canvas.width, canvas.height);

    for (const quality of IMAGE_COMPRESSION_QUALITY_STEPS) {
      // eslint-disable-next-line no-await-in-loop
      const blob = await canvasToBlob(canvas, "image/jpeg", quality);
      if (!blob) {
        break;
      }
      if (!best || blob.size < best.size) {
        best = blob;
      }
      if (blob.size <= targetBytes) {
        break;
      }
    }

    scale *= 0.7;
  }

  source.close?.();

  if (!best || best.size >= file.size) {
    return file;
  }

  return new File([best], toJpegFileName(file.name), {
    type: "image/jpeg",
    lastModified: Date.now(),
  });
}
