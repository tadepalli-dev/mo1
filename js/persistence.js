// persistence.js — extracted from app.js (20 declarations)

function getAuthToken() {
  return localStorage.getItem(STORAGE_KEYS.authToken);
}

function saveAuthToken(token) {
  localStorage.setItem(STORAGE_KEYS.authToken, token);
}

function clearAuthToken() {
  localStorage.removeItem(STORAGE_KEYS.authToken);
}

function authHeaders() {
  const token = getAuthToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function fetchVehicleAssignmentForActiveUser() {
  const email = String(state.activeUser?.email || "").trim().toLowerCase();
  const activeUserName = String(state.activeUser?.name || "");
  if (!email) {
    return { match: null, warnings: [] };
  }

  const localAssignment = VEHICLE_ASSIGNMENTS.find((entry) => {
    const entryEmail = String(entry.email || "").trim().toLowerCase();
    if (entryEmail && entryEmail === email) {
      return true;
    }

    const names = Array.isArray(entry.names) ? entry.names : [];
    return names.some((name) => normalizePersonName(name) === normalizePersonName(activeUserName));
  });
  if (localAssignment) {
    return { match: { ...localAssignment, sourceLabel: "MoTrack directory" }, warnings: [] };
  }

  if (Object.prototype.hasOwnProperty.call(state.vehicleAssignments, email)) {
    return { match: state.vehicleAssignments[email], warnings: [] };
  }

  if (state.vehicleAssignmentRequests[email]) {
    return state.vehicleAssignmentRequests[email];
  }

  const request = fetch(buildApiUrl("/api/vehicle-assignment"), { headers: authHeaders() })
    .then(async (response) => {
      const result = await response.json();
      if (response.status === 401) {
        handleUnauthorized();
      }
      if (!response.ok || !result.ok) {
        throw new Error(result.error || "Could not load vehicle assignment.");
      }
      state.vehicleAssignments[email] = result.match || null;
      return { match: state.vehicleAssignments[email], warnings: result.warnings || [] };
    })
    .finally(() => {
      delete state.vehicleAssignmentRequests[email];
    });

  state.vehicleAssignmentRequests[email] = request;
  return request;
}

// A stored token that the server no longer recognizes (expired, or the
// session was invalidated by /api/logout elsewhere) means this browser is
// no longer really authenticated — drop the local session so the login
// screen shows instead of silently working with stale/default data.
function handleUnauthorized() {
  clearAuthToken();
  localStorage.removeItem(STORAGE_KEYS.session);
}

function mergeUsersFromTasks(users, tasks) {
  const mergedUsers = Array.isArray(users) ? [...users] : [];
  const byEmail = new Map(
    mergedUsers.map((user) => [String(user.email || "").trim().toLowerCase(), user])
  );

  (Array.isArray(tasks) ? tasks : []).forEach((task) => {
    const email = String(task.assigneeEmail || "").trim().toLowerCase();
    if (!email || byEmail.has(email)) {
      return;
    }

    const inferredUser = {
      name: task.assigneeName || email,
      email,
      role: task.assigneeRole || "employee",
      designation: normalizeValue(task.department),
      code: "-",
      dayOff: "-",
    };

    mergedUsers.push(inferredUser);
    byEmail.set(email, inferredUser);
  });

  return mergedUsers;
}

function mergeCompletionMaps(serverCompletions) {
  const localCompletions = loadCompletions();
  const serverMap = serverCompletions && typeof serverCompletions === "object" ? serverCompletions : {};
  const merged = { ...localCompletions };

  Object.entries(serverMap).forEach(([key, value]) => {
    merged[key] = merged[key] ? { ...merged[key], ...value } : value;
  });

  return merged;
}

const REQUIRED_OPERATIONAL_TASKS = Object.freeze([
  {
    taskId: "DILI-902001",
    assigneeName: "Dilip Gupta",
    assigneeEmail: "dilip.gupta@curtainsandcarpets.com",
    title: "IT Works - Computers - Telephone - Camera",
    frequency: "daily",
    department: "IT/cashier",
    details: "IT Works - Computers - Telephone - Camera",
  },
  {
    taskId: "DILI-902002",
    assigneeName: "Dilip Gupta",
    assigneeEmail: "dilip.gupta@curtainsandcarpets.com",
    title: "Inventory Management - By Entry & With Guidance",
    frequency: "daily",
    department: "IT/cashier",
    details: "What, how and how frequently",
  },
  {
    taskId: "DILI-902003",
    assigneeName: "Dilip Gupta",
    assigneeEmail: "dilip.gupta@curtainsandcarpets.com",
    title: "Company Major Password Keeper",
    frequency: "daily",
    department: "IT/cashier",
    details: "Google Form",
  },
  {
    taskId: "DILI-902004",
    assigneeName: "Dilip Gupta",
    assigneeEmail: "dilip.gupta@curtainsandcarpets.com",
    title: "Data Backup - Tally Software Only",
    frequency: "daily",
    department: "IT/cashier",
    details: "Data Backup - Tally Software Only",
  },
  {
    taskId: "DILI-902005",
    assigneeName: "Dilip Gupta",
    assigneeEmail: "dilip.gupta@curtainsandcarpets.com",
    title: "Cash Handling Checklist",
    frequency: "daily",
    department: "IT/cashier",
    details: "Cash Handling Checklist",
  },
  {
    taskId: "DILI-902006",
    assigneeName: "Dilip Gupta",
    assigneeEmail: "dilip.gupta@curtainsandcarpets.com",
    title: "Counter Billing",
    frequency: "daily",
    department: "IT/cashier",
    details: "Counter Billing",
  },
  {
    taskId: "DILI-902007",
    assigneeName: "Dilip Gupta",
    assigneeEmail: "dilip.gupta@curtainsandcarpets.com",
    title: "Assist - When Needed To V1/V2 Work",
    frequency: "daily",
    department: "IT/cashier",
    details: "Assist salesman, inventory team, and account team when needed.",
  },
  {
    taskId: "DILI-902008",
    assigneeName: "Dilip Gupta",
    assigneeEmail: "dilip.gupta@curtainsandcarpets.com",
    title: "Allrounder (Multi Tasking Works)",
    frequency: "daily",
    department: "IT/cashier",
    details: "This is the major work profile.",
  },
  {
    taskId: "ARUN-851986",
    assigneeName: "Arun Mishra",
    assigneeEmail: "arunmishra@modesigns.in",
    title: "Servo Checklist.",
    frequency: "daily",
    department: "Electrician",
    details: "Servo Checklist.",
  },
  {
    taskId: "ARUN-348330",
    assigneeName: "Arun Mishra",
    assigneeEmail: "arunmishra@modesigns.in",
    title: "Generator checklist.",
    frequency: "daily",
    department: "Electrician",
    details: "Generator checklist.",
  },
  {
    taskId: "ARUN-668111",
    assigneeName: "Arun Mishra",
    assigneeEmail: "arunmishra@modesigns.in",
    title: "Ac filter cleaning for every 15 days to be verified by kamla by cctv.",
    frequency: "every_15_days",
    department: "Electrician",
    details: "Ac filter cleaning for every 15 days to be verified by kamla by cctv.",
  },
  {
    taskId: "ARUN-632614",
    assigneeName: "Arun Mishra",
    assigneeEmail: "arunmishra@modesigns.in",
    title: "Ac checklist",
    frequency: "daily",
    department: "Electrician",
    details: "Ac checklist.",
  },
  {
    taskId: "ARUN-608569",
    assigneeName: "Arun Mishra",
    assigneeEmail: "arunmishra@modesigns.in",
    title: "Ro checklist.",
    frequency: "daily",
    department: "Electrician",
    details: "Ro checklist.",
  },
  {
    taskId: "ARUN-853033",
    assigneeName: "Arun Mishra",
    assigneeEmail: "arunmishra@modesigns.in",
    title: "Meter reading in both Mo1 and Mo2.",
    frequency: "daily",
    department: "Electrician",
    details: "Meter reading in both Mo1 and Mo2.",
  },
  {
    taskId: "ABHI-851986",
    assigneeName: "Abhishiek Kumar",
    assigneeEmail: "abhishiek@modesigns.in",
    title: "Servo Checklist.",
    frequency: "daily",
    department: "Electrician",
    details: "Servo Checklist.",
  },
  {
    taskId: "ABHI-348330",
    assigneeName: "Abhishiek Kumar",
    assigneeEmail: "abhishiek@modesigns.in",
    title: "Generator checklist.",
    frequency: "daily",
    department: "Electrician",
    details: "Generator checklist.",
  },
  {
    taskId: "ABHI-668111",
    assigneeName: "Abhishiek Kumar",
    assigneeEmail: "abhishiek@modesigns.in",
    title: "Ac filter cleaning for every 15 days to be verified by kamla by cctv.",
    frequency: "every_15_days",
    department: "Electrician",
    details: "Ac filter cleaning for every 15 days to be verified by kamla by cctv.",
  },
  {
    taskId: "ABHI-632614",
    assigneeName: "Abhishiek Kumar",
    assigneeEmail: "abhishiek@modesigns.in",
    title: "Ac checklist",
    frequency: "daily",
    department: "Electrician",
    details: "Ac checklist.",
  },
  {
    taskId: "ABHI-608569",
    assigneeName: "Abhishiek Kumar",
    assigneeEmail: "abhishiek@modesigns.in",
    title: "Ro checklist.",
    frequency: "daily",
    department: "Electrician",
    details: "Ro checklist.",
  },
  {
    taskId: "ABHI-130356",
    assigneeName: "Abhishiek Kumar",
    assigneeEmail: "abhishiek@modesigns.in",
    title: "Meter reading in both Mo1 and Mo2.",
    frequency: "daily",
    department: "Electrician",
    details: "Meter reading in both Mo1 and Mo2.",
  },
]);

const SHARED_INSTALLER_TASK_TEMPLATES = Object.freeze([
  {
    key: "fuel-checklist",
    title: "Fuel checklist.",
    frequency: "daily",
    department: "installer",
    details: "Fuel checklist.",
  },
  {
    key: "evening-reading",
    title: "Evening Reading.",
    frequency: "daily",
    department: "installer",
    details: "Evening Reading.",
  },
  {
    key: "morning-reading",
    title: "Morning Reading.",
    frequency: "daily",
    department: "installer",
    details: "Morning Reading.",
  },
]);

const LEGACY_REQUIRED_TASK_CLEANUPS = Object.freeze([
  {
    assigneeName: "Dilip Gupta",
    titles: [
      "Send list of calls missed at 5:00PM",
      "check Telephone line is working",
      "check Leaseline is working",
      "Check network speed of all WiFi",
    ],
  },
]);

function isInstallerUser(user) {
  return String(user?.role || "").trim().toLowerCase() === "installer";
}

function normalizeRequiredTaskTitle(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^\w\s]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isSharedInstallerTaskTitle(value) {
  const normalizedTitle = normalizeRequiredTaskTitle(value);
  return SHARED_INSTALLER_TASK_TEMPLATES.some((template) => normalizeRequiredTaskTitle(template.title) === normalizedTitle);
}

function isGeneratedSharedInstallerTaskId(taskId) {
  return String(taskId || "").trim().toUpperCase().startsWith("INSTALLER-");
}

function shouldRemoveLegacyInstallerSharedTask(task, users) {
  const assignee = resolveRequiredTaskAssignee(
    { assigneeEmail: task?.assigneeEmail, assigneeName: task?.assigneeName },
    users
  );
  const taskRole = String(task?.assigneeRole || assignee?.role || "").trim().toLowerCase();
  if (taskRole !== "installer") {
    return false;
  }
  if (!isSharedInstallerTaskTitle(task?.title)) {
    return false;
  }
  return !isGeneratedSharedInstallerTaskId(task?.taskId || task?.id);
}

function buildInstallerTaskId(user, template) {
  const emailSlug = String(user?.email || user?.name || "installer")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `INSTALLER-${emailSlug}-${template.key}`.toUpperCase();
}

function getSharedInstallerTaskDefinitions(users) {
  return (Array.isArray(users) ? users : [])
    .filter(isInstallerUser)
    .flatMap((user) =>
      SHARED_INSTALLER_TASK_TEMPLATES.map((template) => ({
        taskId: buildInstallerTaskId(user, template),
        assigneeName: user.name,
        assigneeEmail: user.email,
        title: template.title,
        frequency: template.frequency,
        department: template.department,
        details: template.details,
      }))
    );
}

function getRequiredOperationalTasks(users) {
  return [...REQUIRED_OPERATIONAL_TASKS, ...getSharedInstallerTaskDefinitions(users)];
}

function resolveRequiredTaskAssignee(definition, users) {
  const normalizedEmail = String(definition.assigneeEmail || "").trim().toLowerCase();
  const normalizedName = normalizePersonName(definition.assigneeName);
  return (Array.isArray(users) ? users : []).find((user) => {
    const userEmail = String(user.email || "").trim().toLowerCase();
    return userEmail === normalizedEmail || normalizePersonName(user.name) === normalizedName;
  }) || null;
}

function buildRequiredOperationalTask(definition, users) {
  const assignee = resolveRequiredTaskAssignee(definition, users);
  const department = normalizeValue(assignee?.designation || definition.department || assignee?.role || "Employee");
  return normalizeTask({
    id: definition.taskId,
    taskId: definition.taskId,
    title: definition.title,
    frequency: definition.frequency,
    department,
    plannedDate: DEFAULT_TASK_START_DATE,
    validUntil: calculateValidUntil(DEFAULT_TASK_START_DATE, definition.frequency),
    details: definition.details || definition.title,
    createdAt: new Date(`${DEFAULT_TASK_START_DATE}T00:00:00`).toISOString(),
    assigneeEmail: assignee?.email || definition.assigneeEmail,
    assigneeName: assignee?.name || definition.assigneeName,
    assigneeRole: assignee?.role || "employee",
    assignedByEmail: assignee?.email || definition.assigneeEmail,
    assignedByName: "System",
    active: true,
  });
}

function matchesRequiredOperationalTask(task, definition) {
  const normalizedTaskId = String(task?.taskId || task?.id || "").trim();
  if (normalizedTaskId && normalizedTaskId === definition.taskId) {
    return true;
  }

  return normalizePersonName(task?.assigneeName) === normalizePersonName(definition.assigneeName)
    && normalizeRequiredTaskTitle(task?.title) === normalizeRequiredTaskTitle(definition.title);
}

function shouldRemoveLegacyRequiredTask(task, users = state.users) {
  const assigneeName = normalizePersonName(task?.assigneeName);
  const title = normalizeTaskTitle(task?.title);
  if (shouldRemoveLegacyInstallerSharedTask(task, users)) {
    return true;
  }
  return LEGACY_REQUIRED_TASK_CLEANUPS.some((cleanup) =>
    normalizePersonName(cleanup.assigneeName) === assigneeName
    && cleanup.titles.some((legacyTitle) => normalizeTaskTitle(legacyTitle) === title)
  );
}

function getDeletedRequiredTaskIds(source = state.deletedRequiredTaskIds) {
  if (!Array.isArray(source)) {
    return [];
  }
  return [...new Set(source.map((taskId) => String(taskId || "").trim()).filter(Boolean))];
}

function getRequiredOperationalDefinition(task, users = state.users) {
  if (!task) {
    return null;
  }
  const normalizedId = String(task.taskId || task.id || "").trim();
  return getRequiredOperationalTasks(users).find((definition) =>
    normalizedId
      ? String(definition.taskId || "").trim() === normalizedId
      : matchesRequiredOperationalTask(task, definition)
  ) || null;
}

function isDeletedRequiredOperationalTask(task, deletedTaskIds = state.deletedRequiredTaskIds, users = state.users) {
  const definition = getRequiredOperationalDefinition(task, users);
  if (!definition) {
    return false;
  }
  const deletedSet = new Set(getDeletedRequiredTaskIds(deletedTaskIds));
  return deletedSet.has(String(definition.taskId || "").trim());
}

function removeDeletedRequiredTaskId(taskId) {
  const normalizedId = String(taskId || "").trim();
  if (!normalizedId) {
    return;
  }
  state.deletedRequiredTaskIds = getDeletedRequiredTaskIds(
    state.deletedRequiredTaskIds.filter((currentId) => String(currentId || "").trim() !== normalizedId)
  );
}

function saveDeletedRequiredTaskIds() {
  state.deletedRequiredTaskIds = getDeletedRequiredTaskIds(state.deletedRequiredTaskIds);
  localStorage.setItem(STORAGE_KEYS.deletedRequiredTasks, JSON.stringify(state.deletedRequiredTaskIds));
  persistCollection("deletedRequiredTasks", state.deletedRequiredTaskIds);
}

function loadDeletedRequiredTaskIds() {
  const raw = localStorage.getItem(STORAGE_KEYS.deletedRequiredTasks);
  if (!raw) {
    return [];
  }

  try {
    return getDeletedRequiredTaskIds(JSON.parse(raw));
  } catch (error) {
    console.error("Could not load deleted required task ids from localStorage.", error);
    return [];
  }
}

function ensureRequiredOperationalTasks(tasks, users, deletedTaskIds = state.deletedRequiredTaskIds) {
  const requiredDefinitions = getRequiredOperationalTasks(users);
  const deletedSet = new Set(getDeletedRequiredTaskIds(deletedTaskIds));
  const normalizedTasks = (Array.isArray(tasks) ? tasks : [])
    .map(normalizeTask)
    .filter((task) => !shouldRemoveLegacyRequiredTask(task, users))
    .filter((task) => !isDeletedRequiredOperationalTask(task, deletedTaskIds, users));
  const missingTasks = requiredDefinitions
    .filter((definition) => !deletedSet.has(String(definition.taskId || "").trim()))
    .filter((definition) => !normalizedTasks.some((task) => matchesRequiredOperationalTask(task, definition)))
    .map((definition) => buildRequiredOperationalTask(definition, users));

  return missingTasks.length ? [...missingTasks, ...normalizedTasks] : normalizedTasks;
}

function syncMergedCompletions(serverCompletions) {
  const merged = mergeCompletionMaps(serverCompletions);
  const serverMap = serverCompletions && typeof serverCompletions === "object" ? serverCompletions : {};
  localStorage.setItem(STORAGE_KEYS.completions, JSON.stringify(merged));

  if (JSON.stringify(merged) !== JSON.stringify(serverMap)) {
    persistCollection("completions", merged);
  }

  return merged;
}

// Once the server has answered, it is the authoritative list of tasks — a
// task absent from the response has been deleted server-side and must not
// be resurrected. This used to union in whatever this browser tab already
// had cached in localStorage (to migrate tasks created before server-side
// storage existed), but that union was permanent: a deleted task sitting in
// one tab's localStorage would get merged back in and PUT right back to the
// server on every load and every 60s refresh, undoing the deletion forever.
function syncMergedTasks(serverTasks, users = state.users) {
  const normalizedServerTasks = ensureRequiredOperationalTasks(
    Array.isArray(serverTasks) ? serverTasks.map(normalizeTask) : [],
    users,
    state.deletedRequiredTaskIds
  );
  localStorage.setItem(STORAGE_KEYS.tasks, JSON.stringify(normalizedServerTasks));
  return normalizedServerTasks;
}

async function bootstrapState() {
  let server = null;
  if (getAuthToken()) {
    try {
      const response = await fetch(buildApiUrl("/api/store"), { headers: authHeaders() });
      if (response.ok) {
        server = await response.json();
      } else if (response.status === 401) {
        handleUnauthorized();
      }
    } catch (error) {
      console.error("Could not reach the server database. Using this browser's local data instead.", error);
    }
  }

  // Each collection is migrated from this browser's localStorage independently:
  // the server might already have real tasks but still be missing, say, pantry
  // alerts recorded before server-side storage existed, and vice versa.
  const resolveCollection = (key, serverValue, isEmpty, loadLocal) => {
    if (server && !isEmpty(serverValue)) {
      return serverValue;
    }
    const local = loadLocal();
    if (server) {
      persistCollection(key, local);
    }
    return local;
  };

  const resolvedUsers = resolveCollection(
    "users",
    Array.isArray(server?.users) ? server.users : [],
    (v) => !v.length,
    loadUsers
  );
  state.deletedRequiredTaskIds = resolveCollection(
    "deletedRequiredTasks",
    Array.isArray(server?.deletedRequiredTasks) ? server.deletedRequiredTasks : [],
    (v) => !Array.isArray(v) || !v.length,
    loadDeletedRequiredTaskIds
  );
  state.tasks = server
    ? syncMergedTasks(Array.isArray(server?.tasks) ? server.tasks : [], resolvedUsers)
    : ensureRequiredOperationalTasks(loadTasks(), resolvedUsers, state.deletedRequiredTaskIds);
  state.users = ensureRequiredUsers(mergeUsersFromTasks(resolvedUsers, state.tasks));
  state.completions = server ? syncMergedCompletions(server.completions) : loadCompletions();
  state.absences = resolveCollection(
    "absences",
    server?.absences && typeof server.absences === "object" ? server.absences : {},
    (v) => !Object.keys(v).length,
    loadAbsences
  );
  state.pantryAlerts = resolveCollection(
    "pantryAlerts",
    Array.isArray(server?.pantryAlerts) ? server.pantryAlerts : [],
    (v) => !v.length,
    loadPantryAlerts
  );
  // No localStorage migration for this one — live location shares are
  // inherently transient, there's nothing meaningful to preserve offline.
  state.liveLocations =
    server?.liveLocations && typeof server.liveLocations === "object" ? server.liveLocations : {};
}


function persistCollection(key, value) {
  fetch(buildApiUrl(`/api/store/${key}`), {
    method: "PUT",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(value),
  })
    .then((response) => {
      if (response.status === 401) {
        handleUnauthorized();
      }
    })
    .catch((error) => {
      console.error(`Could not save "${key}" to the server database. Changes are only saved in this browser for now.`, error);
    });
}

// Unlike bootstrapState (first load only, with local-storage migration),
// this just re-pulls the current server truth into an already-running page —
// used right after login (so a freshly assigned task or new user shows up
// even in a long-lived tab) and on a periodic timer while someone stays
// logged in.

async function refreshStateFromServer() {
  const token = getAuthToken();
  if (!token) {
    return;
  }

  let server = null;
  try {
    const response = await fetch(buildApiUrl("/api/store"), { headers: authHeaders() });
    if (response.ok) {
      server = await response.json();
    } else if (response.status === 401) {
      handleUnauthorized();
      state.activeUser = null;
      toggleViews(false);
      setStatusMessage(elements.loginMessage, "Your session expired. Please sign in again.", "error");
    }
  } catch (error) {
    console.error("Could not refresh data from the server database.", error);
    return;
  }

  if (!server) {
    return;
  }

  state.deletedRequiredTaskIds = getDeletedRequiredTaskIds(
    Array.isArray(server.deletedRequiredTasks) ? server.deletedRequiredTasks : state.deletedRequiredTaskIds
  );

  if (Array.isArray(server.tasks)) {
    state.tasks = syncMergedTasks(
      server.tasks,
      Array.isArray(server.users) && server.users.length ? server.users : state.users
    );
  }
  if (Array.isArray(server.users) && server.users.length) {
    state.users = ensureRequiredUsers(mergeUsersFromTasks(server.users, state.tasks));
  } else {
    state.users = ensureRequiredUsers(mergeUsersFromTasks(state.users, state.tasks));
  }
  if (server.completions && typeof server.completions === "object") {
    state.completions = syncMergedCompletions(server.completions);
  }
  if (server.absences && typeof server.absences === "object") {
    state.absences = server.absences;
  }
  if (Array.isArray(server.pantryAlerts)) {
    state.pantryAlerts = server.pantryAlerts;
  }
  if (server.liveLocations && typeof server.liveLocations === "object") {
    state.liveLocations = server.liveLocations;
  }
}


const SHEET_LEAVE_REFRESH_MS = 60 * 1000;

const SERVER_STATE_REFRESH_MS = 60 * 1000;


function loadSheetLeaveData() {
  const primaryUrl = buildApiUrl("/api/leave-data");
  const fallbackUrl = "/api/leave-data";
  const shouldTryFallback = primaryUrl !== fallbackUrl;

  const readLeaveData = (url) =>
    fetch(url).then((response) => {
      if (!response.ok) {
        throw new Error(`Leave data request failed with status ${response.status}.`);
      }
      return response.json();
    });

  readLeaveData(primaryUrl)
    .catch((error) => {
      if (!shouldTryFallback) {
        throw error;
      }
      console.warn(`Primary leave data request failed for ${primaryUrl}; retrying ${fallbackUrl}.`, error);
      return readLeaveData(fallbackUrl);
    })
    .then((data) => {
      state.sheetLeaves = Array.isArray(data.records) ? data.records : [];
      state.sheetLeaveError = data.error || null;
      renderDashboard();
    })
    .catch((error) => {
      state.sheetLeaveError = error.message;
      renderDashboard();
    });
}


function saveSession(email) {
  localStorage.setItem(STORAGE_KEYS.session, email);
}


function saveRememberedEmail() {
  if (elements.rememberMe.checked) {
    localStorage.setItem(STORAGE_KEYS.rememberedEmail, elements.emailInput.value.trim());
  } else {
    localStorage.removeItem(STORAGE_KEYS.rememberedEmail);
  }
}


function saveUsers() {
  localStorage.setItem(STORAGE_KEYS.users, JSON.stringify(state.users));
  persistCollection("users", state.users);
  syncUsersToSheet(state.users);
}


function syncUsersToSheet(users) {
  const primaryUrl = buildApiUrl("/api/users-sheet-sync");
  const fallbackUrl = "/api/users-sheet-sync";
  const shouldTryFallback = primaryUrl !== fallbackUrl;

  const sendUsers = (url) =>
    fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({ users }),
    }).then((response) => {
      if (!response.ok) {
        throw new Error(`Users sheet sync failed with status ${response.status}.`);
      }
      return response.json();
    });

  sendUsers(primaryUrl)
    .catch((error) => {
      if (!shouldTryFallback) {
        throw error;
      }
      console.warn(`Primary users sheet sync failed for ${primaryUrl}; retrying ${fallbackUrl}.`, error);
      return sendUsers(fallbackUrl);
    })
    .catch((error) => {
      console.error("Could not sync users to Google Sheets.", error);
    });
}


function saveTasks() {
  state.tasks = ensureRequiredOperationalTasks(state.tasks, state.users, state.deletedRequiredTaskIds);
  localStorage.setItem(STORAGE_KEYS.tasks, JSON.stringify(state.tasks));
  persistCollection("tasks", state.tasks);
}


function saveCompletions() {
  localStorage.setItem(STORAGE_KEYS.completions, JSON.stringify(state.completions));
  persistCollection("completions", state.completions);
}


function saveAbsences() {
  localStorage.setItem(STORAGE_KEYS.absences, JSON.stringify(state.absences));
  persistCollection("absences", state.absences);
}


function savePantryAlerts() {
  localStorage.setItem(STORAGE_KEYS.pantryAlerts, JSON.stringify(state.pantryAlerts));
  persistCollection("pantryAlerts", state.pantryAlerts);
}


function saveLiveLocations() {
  persistCollection("liveLocations", state.liveLocations);
}


function loadUsers() {
  const raw = localStorage.getItem(STORAGE_KEYS.users);
  if (!raw) {
    return ensureRequiredUsers(INITIAL_USERS);
  }

  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.length ? ensureRequiredUsers(parsed) : ensureRequiredUsers(INITIAL_USERS);
  } catch (error) {
    console.error("Could not load users from localStorage.", error);
    return ensureRequiredUsers(INITIAL_USERS);
  }
}


function loadTasks() {
  const raw = localStorage.getItem(STORAGE_KEYS.tasks);
  if (!raw) {
    return [];
  }

  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(normalizeTask) : [];
  } catch (error) {
    console.error("Could not load tasks from localStorage.", error);
    return [];
  }
}


function loadCompletions() {
  const raw = localStorage.getItem(STORAGE_KEYS.completions);
  if (!raw) {
    return {};
  }

  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (error) {
    console.error("Could not load checklist completions from localStorage.", error);
    return {};
  }
}


function loadAbsences() {
  const raw = localStorage.getItem(STORAGE_KEYS.absences);
  if (!raw) {
    return {};
  }

  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (error) {
    console.error("Could not load absences from localStorage.", error);
    return {};
  }
}


function loadPantryAlerts() {
  const raw = localStorage.getItem(STORAGE_KEYS.pantryAlerts);
  if (!raw) {
    return [];
  }

  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    console.error("Could not load pantry alerts from localStorage.", error);
    return [];
  }
}


function ensureRequiredUsers(users) {
  const byEmail = new Map(users.map((user) => [user.email.toLowerCase(), { ...user }]));
  REQUIRED_USERS.forEach((requiredUser) => {
    const email = requiredUser.email.toLowerCase();
    const existing = byEmail.get(email);
    byEmail.set(email, { ...requiredUser, ...existing });
  });

  return [...byEmail.values()];
}


function normalizeTask(task) {
  const adjustedTask = applyTaskScheduleOverrides(task);
  const plannedDate = normalizePlannedDate(
    adjustedTask.plannedDate || toDateValue(adjustedTask.createdAt) || DEFAULT_TASK_START_DATE
  );
  const frequency = normalizeFrequency(adjustedTask.frequency);

  let validUntil = adjustedTask.validUntil || calculateValidUntil(plannedDate, frequency);
  const plannedDateValue = new Date(`${plannedDate}T00:00:00`);
  const validUntilDate = new Date(`${validUntil}T00:00:00`);
  if (Number.isNaN(validUntilDate.getTime()) || validUntilDate.getTime() < plannedDateValue.getTime()) {
    validUntil = plannedDate;
  }

  return {
    ...adjustedTask,
    plannedDate,
    frequency,
    validUntil,
    active: adjustedTask.active !== false,
  };
}
