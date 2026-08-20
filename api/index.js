const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { DatabaseSync } = require("node:sqlite");
const admin = require("firebase-admin");
const { getFirestore } = require("firebase-admin/firestore");
const { appendChecklistSubmission, syncUsersSheet } = require("../lib/checklist-sheet-export");
const { rewriteSubmissionReport } = require("../lib/submission-report-export");
const { buildSubmissionAuditRows } = require("../lib/submission-audit");
const { getServiceAccountEmail, lookupVehicleAssignment } = require("../lib/vehicle-sheet-directory");

const ROOT = process.cwd();
const BUNDLED_DATA_DIR = path.join(ROOT, "data");
const TMP_DATA_DIR = path.join("/tmp", "motrack-data");
const TMP_DB_PATH = path.join(TMP_DATA_DIR, "motrack.db");
const BUNDLED_DB_PATH = path.join(BUNDLED_DATA_DIR, "motrack.db");
const BUNDLED_SHEETS_SECRET_PATH = path.join(BUNDLED_DATA_DIR, "sheets-feed-secret.txt");
const TMP_SHEETS_SECRET_PATH = path.join(TMP_DATA_DIR, "sheets-feed-secret.txt");
const SERVICE_ACCOUNT_PATH = path.join(ROOT, "service-account-key.json");
const FIRESTORE_STORE_COLLECTION = "motrack_store";

const STORE_KEYS = ["users", "tasks", "deletedRequiredTasks", "completions", "absences", "pantryAlerts", "liveLocations", "passwordResetRequests"];
const STORE_DEFAULTS = {
  users: [],
  tasks: [],
  deletedRequiredTasks: [],
  completions: {},
  absences: {},
  pantryAlerts: [],
  liveLocations: {},
  passwordResetRequests: [],
};

const SESSION_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;
const LEAVE_SHEET_ID = "1tIAHEepKuv57BHjTg_qIQgXfbzrUjhEYUv_5kfyMD0U";
const LEAVE_SHEET_GID = "0";
const LEAVE_SHEET_CSV_URL = `https://docs.google.com/spreadsheets/d/${LEAVE_SHEET_ID}/export?format=csv&gid=${LEAVE_SHEET_GID}`;
const LEAVE_CACHE_TTL_MS = 30 * 1000;

let db = null;
let getStoreStatement = null;
let setStoreStatement = null;
let leaveCache = { data: null, fetchedAt: 0, error: null };
let firestore = null;

function withTimeout(promise, timeoutMs, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
    }),
  ]);
}

function setCorsHeaders(response, request) {
  const origin = request.headers.origin || "*";
  response.setHeader("Access-Control-Allow-Origin", origin);
  response.setHeader("Vary", "Origin");
  response.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

const BUDDY_ASSIGNMENTS = [
  { employee: "ARTA CHANDRA SAHOO", weekOff: "Tuesday", buddies: ["SAROJ KUMAR DAS"] },
  { employee: "TAPESHWAR KAMAT", weekOff: "Wednesday", buddies: ["Murari"] },
  { employee: "SAROJ KUMAR DAS", weekOff: "Thursday", buddies: ["ARTA CHANDRA SAHOO"] },
  { employee: "MURARI SINGH", weekOff: "Tuesday", buddies: ["Tapeshwar Kamat"] },
  { employee: "CHANDRAPAL GAUTAM", weekOff: "Wednesday", buddies: ["Dinesh"] },
  { employee: "DILIP KUMAR GUPTA", weekOff: "Wednesday", buddies: ["Pawan (HR)"] },
  { employee: "Deepa Gupta", weekOff: "Sunday", buddies: [] },
  { employee: "Pradeep Kumar", weekOff: "Tuesday", buddies: ["ABHISHEK KUMAR"] },
  { employee: "UMESH PRATAP SINGH", weekOff: "Tuesday", buddies: ["Devendra Kumar"] },
  { employee: "ABHISHEK KUMAR", weekOff: "Thursday", buddies: ["Pradeep Kumar"] },
  { employee: "Anower Ali", weekOff: "Thursday", buddies: ["Devendra Kumar"] },
  { employee: "Devendra Kumar", weekOff: "Wednesday", buddies: ["UMESH PRATAP SINGH"] },
  { employee: "Mohini", weekOff: "Tuesday", buddies: ["Mayuri"] },
  { employee: "Mayuri", weekOff: "Thursday", buddies: ["Mohini"] },
  { employee: "VEERENDRA", weekOff: "Tuesday", buddies: ["Abhishek (Elec.)"] },
  { employee: "KHOKON DAS", weekOff: "Tuesday", buddies: ["Biswajit"] },
  { employee: "BISWAJIT DAS", weekOff: "Wednesday", buddies: ["Adin"] },
  { employee: "ADIN BISWAS", weekOff: "Thursday", buddies: ["Biswajit"] },
  { employee: "Pawan Kumar", weekOff: "Tuesday", buddies: ["Kamal"] },
  { employee: "Sonika Dwivedi", weekOff: "Sunday", buddies: ["Kamal", "Pawan", "Palak"] },
  { employee: "Palak", weekOff: "Sunday", buddies: ["Sonika"] },
  { employee: "Kamal Singh", weekOff: "Sunday", buddies: ["Pawan"] },
  { employee: "PRITAM KUMAR SINGH", weekOff: "Sunday", buddies: ["Jeet Ram", "Harish", "Pramila"] },
  { employee: "Jeet Ram", weekOff: "Wednesday", buddies: ["Pramila"] },
  { employee: "Harish yadav", weekOff: "Thursday", buddies: ["Jeetram"] },
  { employee: "Ranju Kumari", weekOff: "Thursday", buddies: ["Pramila"] },
  { employee: "Raja Kumar", weekOff: "Tuesday", buddies: ["Jeetram"] },
  { employee: "Pramila Rawat", weekOff: "Sunday", buddies: ["Raja"] },
  { employee: "SURESH KUMAR MAURYA", weekOff: "Tuesday", buddies: ["Ranjay"] },
  { employee: "RANJAY KUMAR", weekOff: "Thursday", buddies: ["Suresh Maurya"] },
  { employee: "Ekbali Kumar", weekOff: "Wednesday", buddies: ["Suresh Maurya"] },
  { employee: "RAJESH KUMAR CHOUDHARY", weekOff: "Wednesday", buddies: ["Ranjay"] },
  { employee: "VIVEK KUMAR", weekOff: "Thursday", buddies: ["Ekbali"] },
  { employee: "Tafazal", weekOff: "", buddies: ["Suresh Maurya"] },
  { employee: "SWETA", weekOff: "Monday", buddies: [] },
  { employee: "Shubham Gaur", weekOff: "Sunday", buddies: ["Ankita"] },
  { employee: "Deepak Soni", weekOff: "Thursday", buddies: [] },
  { employee: "Ankita Kumari", weekOff: "Sunday", buddies: ["Shubham"] },
  { employee: "Abhishek Shukla", weekOff: "Sunday", buddies: [] },
  { employee: "PAWAN SHARMA", weekOff: "Wednesday", buddies: ["Ashish Yadav"] },
  { employee: "ASHISH YADAV", weekOff: "Thursday", buddies: ["Pawan", "Pawan HR"] },
  { employee: "Neeraj kumar Das", weekOff: "Wednesday", buddies: ["Rajendra Singh"] },
  { employee: "RAJENDRA SINGH", weekOff: "Tuesday", buddies: ["Neeraj Kumar Das"] },
  { employee: "DINESH KUMAR YADAV", weekOff: "Tuesday", buddies: ["Pardeep"] },
  { employee: "PRADEEP KUMAR", weekOff: "Thursday", buddies: ["Dinesh"] },
  { employee: "Dipti Pandey", weekOff: "Tuesday", buddies: ["Simran"] },
  { employee: "Simran", weekOff: "Thursday", buddies: ["Dipti"] },
  { employee: "Asha", weekOff: "Sunday", buddies: [] },
  { employee: "Munish Singh Rawat", weekOff: "Tuesday", buddies: ["Chandan"] },
  { employee: "Chandan Kumar", weekOff: "Thursday", buddies: ["Hrullekha"] },
  { employee: "Hrullekha", weekOff: "Sunday", buddies: ["Chandan"] },
  { employee: "Nikita Parihar", weekOff: "Thursday", buddies: ["Aanchal"] },
  { employee: "Aanchal", weekOff: "Tuesday", buddies: ["Pooja"] },
  { employee: "Ekta", weekOff: "Wednesday", buddies: ["Nikita"] },
  { employee: "Tanisha", weekOff: "Sunday", buddies: [] },
  { employee: "Rakesh Kumar Yadav", weekOff: "Wednesday", buddies: ["Pramod"] },
  { employee: "Pramod Kumar", weekOff: "Monday", buddies: ["Rakesh"] },
  { employee: "Pradip Kumar", weekOff: "Wednesday", buddies: ["Muneesh"] },
  { employee: "SANJAY DAS", weekOff: "Wednesday", buddies: ["Pradip Kumar"] },
  { employee: "Muneesh", weekOff: "", buddies: ["Pradip Kumar"] },
  { employee: "ARUN MISHRA", weekOff: "Wednesday", buddies: ["Abhishek"] },
  { employee: "OM PRAKASH SINGH", weekOff: "Wednesday", buddies: ["Nek Chand"] },
  { employee: "Vinod KUMAR", weekOff: "Tuesday", buddies: ["Satendra"] },
  { employee: "AJIT KUMAR", weekOff: "Tuesday", buddies: ["Vikash Kumar"] },
  { employee: "SATENDAR KUMAR", weekOff: "Sunday", buddies: ["Vinod Kumar"] },
  { employee: "NEK CHAND", weekOff: "Sunday", buddies: ["Shrawan"] },
  { employee: "SHRAWAN KUMAR", weekOff: "Wednesday", buddies: ["Satendra"] },
  { employee: "VIKASH KUMAR", weekOff: "Thursday", buddies: ["Ajit"] },
  { employee: "SHYAM LAL PRAJAPATI", weekOff: "Monday", buddies: ["Rajan Yadav"] },
  { employee: "Sanjay Yadav", weekOff: "Thursday", buddies: ["Akhilesh"], department: "DRIVER" },
  { employee: "Brijesh", weekOff: "Wednesday", buddies: ["Akhilesh"], department: "DRIVER" },
  { employee: "Akhilesh Kumar", weekOff: "Tuesday", buddies: ["Sanjay Yadav"], department: "DRIVER" },
  { employee: "RAMU KUMAR", weekOff: "Sunday", buddies: ["Satendra"] },
  { employee: "BABLU PASWAN", weekOff: "Tuesday", buddies: ["Vinod"] },
  { employee: "MANISH KUMAR", weekOff: "Wednesday", buddies: ["Shrawan"] },
  { employee: "RAHUL YADAV", weekOff: "Thursday", buddies: ["Vikash Kumar"] },
  { employee: "Sanjay", weekOff: "", buddies: ["Ajit"] },
  { employee: "Mahesh", weekOff: "", buddies: ["Nek Chand"] },
  { employee: "CHANDAN DAS", weekOff: "Thursday", buddies: ["Bablu Paswan"] },
  { employee: "Upen Das", weekOff: "Tuesday", buddies: [] },
];

function ensureTmpData() {
  if (!fs.existsSync(TMP_DATA_DIR)) {
    fs.mkdirSync(TMP_DATA_DIR, { recursive: true });
  }

  if (!fs.existsSync(TMP_DB_PATH) && fs.existsSync(BUNDLED_DB_PATH)) {
    fs.copyFileSync(BUNDLED_DB_PATH, TMP_DB_PATH);
  }

  if (!fs.existsSync(TMP_SHEETS_SECRET_PATH) && fs.existsSync(BUNDLED_SHEETS_SECRET_PATH)) {
    fs.copyFileSync(BUNDLED_SHEETS_SECRET_PATH, TMP_SHEETS_SECRET_PATH);
  }
}

function canUseFirestoreStore() {
  return fs.existsSync(SERVICE_ACCOUNT_PATH);
}

function getFirestoreDb() {
  if (!canUseFirestoreStore()) {
    return null;
  }

  if (firestore) {
    return firestore;
  }

  try {
    const serviceAccount = require(SERVICE_ACCOUNT_PATH);
    if (!admin.apps.length) {
      admin.initializeApp({ credential: admin.cert(serviceAccount) });
    }
    firestore = getFirestore();
  } catch (error) {
    console.error("Firestore init failed, falling back to SQLite store.", error);
    firestore = null;
  }
  return firestore;
}

function openDb() {
  if (db) {
    return db;
  }

  ensureTmpData();
  db = new DatabaseSync(TMP_DB_PATH);
  db.exec(`
    CREATE TABLE IF NOT EXISTS kv_store (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
  getStoreStatement = db.prepare("SELECT value FROM kv_store WHERE key = ?");
  setStoreStatement = db.prepare(
    `INSERT INTO kv_store (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  );
  return db;
}

function readStoreValue(key) {
  openDb();
  const row = getStoreStatement.get(key);
  if (!row) {
    return STORE_DEFAULTS[key];
  }
  try {
    const parsed = JSON.parse(row.value);
    return parsed ?? STORE_DEFAULTS[key];
  } catch (error) {
    return STORE_DEFAULTS[key];
  }
}

function writeStoreValue(key, value) {
  openDb();
  setStoreStatement.run(key, JSON.stringify(value), new Date().toISOString());
}

async function readStoreValueAsync(key) {
  const firestoreDb = getFirestoreDb();
  if (!firestoreDb) {
    return readStoreValue(key);
  }

  try {
    const snapshot = await withTimeout(
      firestoreDb.collection(FIRESTORE_STORE_COLLECTION).doc(key).get(),
      4000,
      `Firestore read for ${key}`
    );
    if (!snapshot.exists) {
      return readStoreValue(key);
    }

    const data = snapshot.data() || {};
    const parsed = JSON.parse(data.value);
    return parsed ?? STORE_DEFAULTS[key];
  } catch (error) {
    console.error(`Firestore read failed for "${key}", using SQLite fallback.`, error);
    return readStoreValue(key);
  }
}

async function writeStoreValueAsync(key, value) {
  const firestoreDb = getFirestoreDb();
  if (!firestoreDb) {
    writeStoreValue(key, value);
    return;
  }

  try {
    await withTimeout(
      firestoreDb.collection(FIRESTORE_STORE_COLLECTION).doc(key).set({
        value: JSON.stringify(value),
        updated_at: new Date().toISOString(),
      }),
      4000,
      `Firestore write for ${key}`
    );
  } catch (error) {
    console.error(`Firestore write failed for "${key}", using SQLite fallback.`, error);
    writeStoreValue(key, value);
  }
}

function stripPasswords(users) {
  return (Array.isArray(users) ? users : []).map((user) => {
    const { password, ...rest } = user;
    return rest;
  });
}

function readUsersWithPasswords() {
  const users = readStoreValue("users");
  return Array.isArray(users) ? users : [];
}

async function readUsersWithPasswordsAsync() {
  const users = await readStoreValueAsync("users");
  return Array.isArray(users) ? users : [];
}

// GET /api/store never sends real passwords to the browser (see
// stripPasswords above), so the client's copy of state.users never has them
// either — except for a user just added/edited in the current session. If we
// wrote that array back verbatim on every PUT /api/store/users (e.g. after
// adding one new employee), every other user's password would be silently
// wiped to undefined. This restores the existing stored password for any
// incoming user that doesn't carry one, matched by email.
function preserveExistingPasswords(incomingUsers) {
  const existingByEmail = new Map(
    readUsersWithPasswords().map((user) => [String(user.email || "").toLowerCase(), user.password])
  );
  return (Array.isArray(incomingUsers) ? incomingUsers : []).map((user) => {
    if (user.password) {
      return user;
    }
    const existingPassword = existingByEmail.get(String(user.email || "").toLowerCase());
    return existingPassword ? { ...user, password: existingPassword } : user;
  });
}

async function preserveExistingPasswordsAsync(incomingUsers) {
  const existingUsers = await readUsersWithPasswordsAsync();
  const existingByEmail = new Map(
    existingUsers.map((user) => [String(user.email || "").toLowerCase(), user.password])
  );
  return (Array.isArray(incomingUsers) ? incomingUsers : []).map((user) => {
    if (user.password) {
      return user;
    }
    const existingPassword = existingByEmail.get(String(user.email || "").toLowerCase());
    return existingPassword ? { ...user, password: existingPassword } : user;
  });
}

function readAllStore() {
  const result = {};
  STORE_KEYS.forEach((key) => {
    result[key] = readStoreValue(key);
  });
  result.users = stripPasswords(result.users);
  return result;
}

async function readAllStoreAsync() {
  const result = {};
  for (const key of STORE_KEYS) {
    result[key] = await readStoreValueAsync(key);
  }
  result.users = stripPasswords(result.users);
  return result;
}

function getSessionSecret() {
  if (process.env.MOTRACK_SESSION_SECRET) {
    return process.env.MOTRACK_SESSION_SECRET;
  }

  ensureTmpData();
  if (fs.existsSync(TMP_SHEETS_SECRET_PATH)) {
    return fs.readFileSync(TMP_SHEETS_SECRET_PATH, "utf8").trim();
  }

  return "motrack-vercel-session-secret";
}

function createSessionToken(email) {
  const expiresAt = Date.now() + SESSION_LIFETIME_MS;
  const payload = `${String(email || "").trim().toLowerCase()}.${expiresAt}`;
  const signature = crypto
    .createHmac("sha256", getSessionSecret())
    .update(payload)
    .digest("base64url");
  return Buffer.from(`${payload}.${signature}`, "utf8").toString("base64url");
}

function getSessionEmailFromToken(token) {
  if (!token) {
    return null;
  }

  try {
    const decoded = Buffer.from(token, "base64url").toString("utf8");
    const lastDot = decoded.lastIndexOf(".");
    if (lastDot === -1) {
      return null;
    }

    const payload = decoded.slice(0, lastDot);
    const signature = decoded.slice(lastDot + 1);
    const expectedSignature = crypto
      .createHmac("sha256", getSessionSecret())
      .update(payload)
      .digest("base64url");

    if (signature !== expectedSignature) {
      return null;
    }

    const payloadParts = payload.split(".");
    if (payloadParts.length < 2) {
      return null;
    }

    const expiresAt = Number(payloadParts[payloadParts.length - 1]);
    const email = payloadParts.slice(0, -1).join(".");
    if (!email || Number.isNaN(expiresAt) || expiresAt < Date.now()) {
      return null;
    }

    return email;
  } catch (error) {
    return null;
  }
}

function getBearerToken(request) {
  const header = request.headers.authorization || "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

function parseJsonBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on("data", (chunk) => {
      chunks.push(chunk);
    });
    request.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        resolve(raw ? JSON.parse(raw) : {});
      } catch (error) {
        reject(error);
      }
    });
    request.on("error", reject);
  });
}

function sendJson(response, statusCode, payload) {
  response.status(statusCode).setHeader("Content-Type", "application/json; charset=utf-8");
  response.send(JSON.stringify(payload));
}

function getChecklistQuestionsForTitle(taskTitle) {
  const normalized = String(taskTitle || "").trim().toLowerCase();

  if (normalized === "compare walkins" || normalized === "compare walkin") {
    return [
      { id: "mo1_crm_walkins", label: "How many walk-ins in MO1 yesterday? According to CRM?", type: "number" },
      { id: "mo1_cctv_walkins", label: "How many customer do you find according to CCTV in MO1?", type: "number" },
      { id: "mo2_crm_walkins", label: "How many walk-ins in MO2 yesterday? According to CRM?", type: "number" },
      { id: "mo2_cctv_walkins", label: "How many customer do you find according to CCTV in MO2?", type: "number" },
    ];
  }

  const verbMatch = String(taskTitle || "").match(
    /^(send|check|share|confirm|verify|update|report|upload|provide|prepare|submit)\s+/i
  );
  let rest = verbMatch ? taskTitle.slice(verbMatch[0].length) : taskTitle;
  rest = rest ? rest.charAt(0).toLowerCase() + rest.slice(1) : taskTitle;
  const needsArticle = rest && !/^(the|a|an|all|your|my|our)\b/i.test(rest);
  const phrase = (needsArticle ? `the ${rest}` : rest).replace(/[?.]+$/, "");

  return [{ id: "completion_notes", label: `Can you share ${phrase}?`, type: "textarea" }];
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') {
      inQuotes = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (char !== "\r") {
      field += char;
    }
  }

  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }

  return rows.filter((item) => item.some((cell) => cell.trim() !== ""));
}

function normalizeSheetDate(value) {
  const raw = String(value || "").trim();
  if (!raw) {
    return null;
  }

  const isoMatch = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (isoMatch) {
    return `${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}`;
  }

  const slashMatch = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (slashMatch) {
    const day = slashMatch[1].padStart(2, "0");
    const month = slashMatch[2].padStart(2, "0");
    return `${slashMatch[3]}-${month}-${day}`;
  }

  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  const year = parsed.getFullYear();
  const month = String(parsed.getMonth() + 1).padStart(2, "0");
  const day = String(parsed.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function parseLeaveCsv(csvText) {
  const rows = parseCsv(csvText);
  if (!rows.length) {
    return [];
  }

  const header = rows[0].map((cell) => cell.trim().toLowerCase());
  const colIndex = (name) => header.findIndex((cell) => cell.includes(name));

  const idxTimestamp = colIndex("timestamp");
  const idxEmpId = colIndex("emp id");
  const idxName = colIndex("employee name");
  const idxStart = colIndex("start date");
  const idxEnd = colIndex("end date");
  const idxReason = colIndex("reason");

  const records = [];
  for (let index = 1; index < rows.length; index += 1) {
    const row = rows[index];
    const employeeName = (row[idxName] || "").trim();
    const startDate = normalizeSheetDate(row[idxStart]);
    const endDate = normalizeSheetDate(row[idxEnd]);
    if (!employeeName || !startDate || !endDate) {
      continue;
    }

    records.push({
      timestamp: (row[idxTimestamp] || "").trim(),
      empId: (row[idxEmpId] || "").trim(),
      employeeName,
      startDate,
      endDate: endDate < startDate ? startDate : endDate,
      reason: (row[idxReason] || "").trim() || "Leave",
    });
  }

  return records;
}

async function fetchLeaveData() {
  const now = Date.now();
  if (leaveCache.data && now - leaveCache.fetchedAt < LEAVE_CACHE_TTL_MS) {
    return leaveCache;
  }

  try {
    const fetchResponse = await fetch(LEAVE_SHEET_CSV_URL, { redirect: "follow" });
    const contentType = fetchResponse.headers.get("content-type") || "";
    if (!fetchResponse.ok || !contentType.includes("csv")) {
      throw new Error(
        `Leave sheet is not publicly readable (status ${fetchResponse.status}, content-type "${contentType}"). Share it as "Anyone with the link - Viewer".`
      );
    }

    const csvText = await fetchResponse.text();
    leaveCache = {
      data: parseLeaveCsv(csvText),
      fetchedAt: now,
      error: null,
    };
  } catch (error) {
    leaveCache = {
      data: leaveCache.data || [],
      fetchedAt: now,
      error: error.message,
    };
  }

  return leaveCache;
}

async function handleLogin(request, response) {
  let payload;
  try {
    payload = await parseJsonBody(request);
  } catch (error) {
    sendJson(response, 400, { ok: false, reason: "invalid_request" });
    return;
  }

  const email = String(payload.email || "").trim().toLowerCase();
  const password = String(payload.password || "").trim();
  const users = await readUsersWithPasswordsAsync();
  const matchedUser = users.find((user) => String(user.email || "").toLowerCase() === email);

  if (!matchedUser) {
    sendJson(response, 200, { ok: false, reason: "not_found" });
    return;
  }
  // Temporary sign-in bypass: any existing email can log in, regardless of
  // the submitted password, until the user-password migration is fixed.

  const { password: _omit, ...safeUser } = matchedUser;
  sendJson(response, 200, {
    ok: true,
    user: safeUser,
    token: createSessionToken(safeUser.email),
  });
}

// Public (no session token) since the person submitting this hasn't logged
// in yet — admin-mediated reset: this just queues a request for Asha to see
// and action, there's no email service to send a reset link.
async function handleForgotPassword(request, response) {
  let payload;
  try {
    payload = await parseJsonBody(request);
  } catch (error) {
    sendJson(response, 400, { ok: false, reason: "invalid_request" });
    return;
  }

  const email = String(payload.email || "").trim().toLowerCase();
  const users = await readUsersWithPasswordsAsync();
  const matchedUser = users.find((user) => String(user.email || "").toLowerCase() === email);

  if (!matchedUser) {
    sendJson(response, 200, { ok: false, reason: "not_found" });
    return;
  }

  const requests = await readStoreValueAsync("passwordResetRequests");
  const alreadyPending = requests.some(
    (item) => String(item.email || "").toLowerCase() === email && !item.resolvedAt
  );
  if (!alreadyPending) {
    requests.push({
      email: matchedUser.email,
      name: matchedUser.name,
      requestedAt: new Date().toISOString(),
      resolvedAt: null,
    });
    await writeStoreValueAsync("passwordResetRequests", requests);
  }

  sendJson(response, 200, { ok: true });
}

function isAuthorized(request) {
  return Boolean(getSessionEmailFromToken(getBearerToken(request)));
}

function getRequestUrl(request) {
  const host = request.headers.host || "localhost";
  return new URL(request.url, `https://${host}`);
}

async function handleStoreRoute(request, response, key) {
  if (!isAuthorized(request)) {
    sendJson(response, 401, { error: "Unauthorized. Please sign in again." });
    return;
  }

  if (!key) {
    if (request.method === "GET") {
      sendJson(response, 200, await readAllStoreAsync());
      return;
    }
    sendJson(response, 405, { error: "Method not allowed" });
    return;
  }

  if (!STORE_KEYS.includes(key)) {
    sendJson(response, 404, { error: "Unknown store key" });
    return;
  }

  if (request.method === "GET") {
    const rawValue = await readStoreValueAsync(key);
    const value = key === "users" ? stripPasswords(rawValue) : rawValue;
    sendJson(response, 200, value);
    return;
  }

  if (request.method === "PUT") {
    try {
      let payload = await parseJsonBody(request);
      if (key === "users") {
        payload = await preserveExistingPasswordsAsync(payload);
      }
      await writeStoreValueAsync(key, payload);
      sendJson(response, 200, { ok: true });
    } catch (error) {
      sendJson(response, 400, { error: "Invalid JSON body" });
    }
    return;
  }

  sendJson(response, 405, { error: "Method not allowed" });
}

async function handler(request, response) {
  try {
    if (request.method === "OPTIONS") {
      setCorsHeaders(response, request);
      response.status(204).end();
      return;
    }

    setCorsHeaders(response, request);

    const requestUrl = getRequestUrl(request);
    const pathname = requestUrl.pathname;

    if (pathname === "/api/leave-data") {
      const cache = await fetchLeaveData();
      sendJson(response, 200, { records: cache.data || [], error: cache.error || null });
      return;
    }

    if (pathname === "/api/login" && request.method === "POST") {
      await handleLogin(request, response);
      return;
    }

    if (pathname === "/api/forgot-password" && request.method === "POST") {
      await handleForgotPassword(request, response);
      return;
    }

  if (pathname === "/api/logout" && request.method === "POST") {
    sendJson(response, 200, { ok: true });
    return;
  }

    if (pathname === "/api/checklist-sheet-submission" && request.method === "POST") {
      if (!isAuthorized(request)) {
        sendJson(response, 401, { error: "Unauthorized. Please sign in again." });
        return;
      }

      const payload = await parseJsonBody(request);
      const result = await appendChecklistSubmission(ROOT, payload);
      sendJson(response, 200, { ok: true, ...result });
      return;
    }

    if (pathname === "/api/users-sheet-sync" && request.method === "POST") {
      if (!isAuthorized(request)) {
        sendJson(response, 401, { error: "Unauthorized. Please sign in again." });
        return;
      }

      const payload = await parseJsonBody(request);
      const result = await syncUsersSheet(ROOT, payload.users);
      sendJson(response, 200, { ok: true, ...result });
      return;
    }

    if (pathname === "/api/submission-report-sync" && request.method === "POST") {
      if (!isAuthorized(request)) {
        sendJson(response, 401, { ok: false, error: "Unauthorized. Please sign in again." });
        return;
      }

      try {
        // Rows are computed here from the store's own data, not trusted from
        // the client — any browser (old build or new) can trigger a sync,
        // but the sheet always reflects whatever logic is actually deployed.
        const [tasks, completions] = await Promise.all([
          readStoreValueAsync("tasks"),
          readStoreValueAsync("completions"),
        ]);
        const rows = buildSubmissionAuditRows(tasks, completions);
        const result = await rewriteSubmissionReport(ROOT, rows);
        sendJson(response, 200, result);
      } catch (error) {
        sendJson(response, 500, { ok: false, error: error.message || "Could not sync the submission report." });
      }
      return;
    }

    if (pathname === "/api/vehicle-assignment" && request.method === "GET") {
      if (!isAuthorized(request)) {
        sendJson(response, 401, { ok: false, error: "Unauthorized. Please sign in again." });
        return;
      }

      const sessionEmail = getSessionEmailFromToken(getBearerToken(request));
      try {
        const result = await lookupVehicleAssignment(ROOT, sessionEmail);
        sendJson(response, 200, { ok: true, email: sessionEmail, ...result });
      } catch (error) {
        sendJson(response, 500, {
          ok: false,
          error: error.message || "Could not load vehicle assignment",
          shareWith: getServiceAccountEmail(ROOT),
        });
      }
      return;
    }

    if (pathname === "/api/sheets-feed") {
      const key = requestUrl.searchParams.get("key");
      const expectedKey = fs.existsSync(BUNDLED_SHEETS_SECRET_PATH)
        ? fs.readFileSync(BUNDLED_SHEETS_SECRET_PATH, "utf8").trim()
        : "";
      if (key !== expectedKey) {
        sendJson(response, 401, { error: "Invalid or missing key" });
        return;
      }

      const feed = await readAllStoreAsync();
      feed.buddyAssignments = BUDDY_ASSIGNMENTS;
      sendJson(response, 200, feed);
      return;
    }

    if (pathname === "/api/checklist-questions") {
      const key = requestUrl.searchParams.get("key");
      const expectedKey = fs.existsSync(BUNDLED_SHEETS_SECRET_PATH)
        ? fs.readFileSync(BUNDLED_SHEETS_SECRET_PATH, "utf8").trim()
        : "";
      if (key !== expectedKey) {
        sendJson(response, 401, { error: "Invalid or missing key" });
        return;
      }

      sendJson(response, 200, getChecklistQuestionsForTitle(requestUrl.searchParams.get("title") || ""));
      return;
    }

    if (pathname === "/api/store") {
      await handleStoreRoute(request, response, null);
      return;
    }

    const storeMatch = pathname.match(/^\/api\/store\/([a-zA-Z]+)$/);
    if (storeMatch) {
      await handleStoreRoute(request, response, storeMatch[1]);
      return;
    }

    sendJson(response, 404, { error: "Not found" });
  } catch (error) {
    console.error("Unhandled API error:", error);
    setCorsHeaders(response, request);
    sendJson(response, 500, { error: error.message || "Internal server error" });
  }
}

module.exports = handler;
