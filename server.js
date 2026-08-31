const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { DatabaseSync } = require("node:sqlite");
const { appendChecklistSubmission, syncUsersSheet } = require("./lib/checklist-sheet-export");
const { getServiceAccountEmail, lookupVehicleAssignment } = require("./lib/vehicle-sheet-directory");
const { rewriteSubmissionReport } = require("./lib/submission-report-export");
const { buildSubmissionAuditRows } = require("./lib/submission-audit");
const { appendClientFormSubmissionRow } = require("./lib/client-form-sheet-export");
const { rewriteSubmittedTaskDetailsSheet } = require("./lib/submitted-task-details-export");

const DEFAULT_PORT = Number(process.env.PORT) || 3000;
const ROOT = __dirname;
const SERVICE_ACCOUNT_PATH = path.join(ROOT, "service-account-key.json");
const CLIENT_FORM_SUBMISSIONS_COLLECTION = "client_form_submissions";
let clientFormFirestore = null;

// Lazy so a missing service-account-key.json doesn't crash every other
// route on startup — only client-form-submissions actually needs Firestore.
function getClientFormFirestore() {
  if (clientFormFirestore) {
    return clientFormFirestore;
  }
  if (!fs.existsSync(SERVICE_ACCOUNT_PATH)) {
    return null;
  }
  const admin = require("firebase-admin");
  const { getFirestore } = require("firebase-admin/firestore");
  // Not admin.apps.length — this firebase-admin version doesn't expose
  // .apps as a property (only the getApps() function), so that check
  // throws instead of ever returning false.
  if (!admin.getApps().length) {
    admin.initializeApp({ credential: admin.cert(require(SERVICE_ACCOUNT_PATH)) });
  }
  clientFormFirestore = getFirestore();
  return clientFormFirestore;
}

const DATA_DIR = path.join(ROOT, "data");
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const db = new DatabaseSync(path.join(DATA_DIR, "motrack.db"));
// Without this, a second short-lived connection to the same file (e.g. a
// one-off migration script run while the server is up) can hit the write
// lock and get SQLITE_BUSY immediately, crashing the server on an uncaught
// exception instead of just waiting the few ms it takes the other writer
// to finish.
db.exec(`PRAGMA busy_timeout = 5000`);
db.exec(`
  CREATE TABLE IF NOT EXISTS kv_store (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    email TEXT NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  )
`);

const SESSION_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

const insertSessionStatement = db.prepare(
  "INSERT INTO sessions (token, email, created_at, expires_at) VALUES (?, ?, ?, ?)"
);
const getSessionStatement = db.prepare("SELECT * FROM sessions WHERE token = ?");
const deleteSessionStatement = db.prepare("DELETE FROM sessions WHERE token = ?");

// A user can have more than one real-world email (e.g. their MoTrack record
// predates a rename, or they log in with whichever address they remember) —
// aliasEmails lets any of those match at login/forgot-password without
// duplicating the account. Everything downstream (tasks, sessions) still
// keys off the single canonical user.email, so nothing else needs to change.
function matchesUserEmail(user, email) {
  if (String(user.email || "").toLowerCase() === email) {
    return true;
  }
  return (user.aliasEmails || []).some((alias) => String(alias || "").toLowerCase() === email);
}

function createSession(email) {
  const token = crypto.randomBytes(32).toString("hex");
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SESSION_LIFETIME_MS);
  insertSessionStatement.run(token, email, now.toISOString(), expiresAt.toISOString());
  return token;
}

function getSessionEmail(token) {
  if (!token) {
    return null;
  }
  const row = getSessionStatement.get(token);
  if (!row) {
    return null;
  }
  if (new Date(row.expires_at).getTime() < Date.now()) {
    deleteSessionStatement.run(token);
    return null;
  }
  return row.email;
}

function deleteSession(token) {
  if (token) {
    deleteSessionStatement.run(token);
  }
}

function getBearerToken(request) {
  const header = request.headers.authorization || "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

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

const getStoreStatement = db.prepare("SELECT value FROM kv_store WHERE key = ?");
const setStoreStatement = db.prepare(
  `INSERT INTO kv_store (key, value, updated_at) VALUES (?, ?, ?)
   ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
);

function readStoreValue(key) {
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
  setStoreStatement.run(key, JSON.stringify(value), new Date().toISOString());
}

function readAllStore() {
  const result = {};
  STORE_KEYS.forEach((key) => {
    result[key] = readStoreValue(key);
  });
  result.users = stripPasswords(result.users);
  return result;
}

// A separate secret from user login tokens, used only by the Sheets/Looker
// Studio export feed (see /api/sheets-feed below). Kept out of version
// control and generated once, so the sync doesn't need a real user account.
const SHEETS_FEED_SECRET_PATH = path.join(DATA_DIR, "sheets-feed-secret.txt");
function getOrCreateSheetsFeedSecret() {
  if (fs.existsSync(SHEETS_FEED_SECRET_PATH)) {
    return fs.readFileSync(SHEETS_FEED_SECRET_PATH, "utf8").trim();
  }
  const secret = crypto.randomBytes(24).toString("hex");
  fs.writeFileSync(SHEETS_FEED_SECRET_PATH, secret, "utf8");
  return secret;
}
const SHEETS_FEED_SECRET = getOrCreateSheetsFeedSecret();

// Passwords stay server-side so they never leave the backend in /api/store
// responses, even while login is temporarily bypassing password checks.
function stripPasswords(users) {
  return (Array.isArray(users) ? users : []).map((user) => {
    const { password, ...rest } = user;
    return rest;
  });
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

function readUsersWithPasswords() {
  const users = readStoreValue("users");
  return Array.isArray(users) ? users : [];
}

// Buddy/week-off roster and checklist-question rules, mirrored here (from
// js/data.js and js/business.js in the main app) so that external clients
// like the Apps Script viewer can fetch them fresh from the server instead
// of keeping their own hardcoded copy. If you update the roster or add a
// checklist template in the main app, update it here too to keep both in
// sync — the Apps Script side then picks it up automatically on next load,
// with no redeployment needed.
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

const LEAVE_SHEET_ID = "1tIAHEepKuv57BHjTg_qIQgXfbzrUjhEYUv_5kfyMD0U";
const LEAVE_SHEET_GID = "0";
const LEAVE_SHEET_CSV_URL = `https://docs.google.com/spreadsheets/d/${LEAVE_SHEET_ID}/export?format=csv&gid=${LEAVE_SHEET_GID}`;
const LEAVE_CACHE_TTL_MS = 30 * 1000;

let leaveCache = { data: null, fetchedAt: 0, error: null };

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
          i++;
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
    } else if (char === "\r") {
      // skip, \n handles the row break
    } else {
      field += char;
    }
  }

  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }

  return rows.filter((r) => r.some((cell) => cell.trim() !== ""));
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
  if (!Number.isNaN(parsed.getTime())) {
    const year = parsed.getFullYear();
    const month = String(parsed.getMonth() + 1).padStart(2, "0");
    const day = String(parsed.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  return null;
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
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
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
    const response = await fetch(LEAVE_SHEET_CSV_URL, { redirect: "follow" });
    const contentType = response.headers.get("content-type") || "";

    if (!response.ok || !contentType.includes("csv")) {
      throw new Error(
        `Leave sheet is not publicly readable (status ${response.status}, content-type "${contentType}"). Share it as "Anyone with the link - Viewer".`
      );
    }

    const csvText = await response.text();
    const data = parseLeaveCsv(csvText);
    leaveCache = { data, fetchedAt: now, error: null };
  } catch (error) {
    leaveCache = { data: leaveCache.data || [], fetchedAt: now, error: error.message };
  }

  return leaveCache;
}

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

function setCorsHeaders(response, request) {
  const origin = request.headers.origin || "*";
  response.setHeader("Access-Control-Allow-Origin", origin);
  response.setHeader("Vary", "Origin");
  response.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

function parseJsonBody(request, maxBytes = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > maxBytes) {
        request.destroy();
        reject(new Error("Request body too large"));
      }
    });
    request.on("end", () => {
      try {
        resolve(JSON.parse(body || "{}"));
      } catch (error) {
        reject(error);
      }
    });
    request.on("error", reject);
  });
}

const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || "http://localhost:11434";
const OLLAMA_VISION_MODEL = process.env.OLLAMA_VISION_MODEL || "moondream";

async function readNumberFromImageWithOllama(imageBase64, unitHint) {
  if (!imageBase64) {
    throw new Error("No image was provided.");
  }

  const prompt = unitHint
    ? `You are reading a photo of a digital display or gauge. Reply with ONLY the numeric reading shown next to or associated with "${unitHint}" - no words, no units, just the number (for example: 2347.6). If you cannot find a reading for "${unitHint}", reply with exactly: NONE`
    : `You are reading a photo of a digital display or gauge. Reply with ONLY the main numeric reading shown - no words, no units, just the number. If there are several numbers, pick the single most prominent reading. If you cannot read a number, reply with exactly: NONE`;

  let ollamaResponse;
  try {
    ollamaResponse = await fetch(`${OLLAMA_BASE_URL}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: OLLAMA_VISION_MODEL,
        prompt,
        images: [imageBase64],
        stream: false,
      }),
    });
  } catch (error) {
    throw new Error(
      `Could not reach Ollama at ${OLLAMA_BASE_URL}. Make sure Ollama is installed and running on this machine.`
    );
  }

  if (!ollamaResponse.ok) {
    const errorBody = await ollamaResponse.text().catch(() => "");
    throw new Error(
      `Ollama request failed with status ${ollamaResponse.status}. ${errorBody || `Is the "${OLLAMA_VISION_MODEL}" model pulled (ollama pull ${OLLAMA_VISION_MODEL})?`}`
    );
  }

  const data = await ollamaResponse.json();
  const text = String(data.response || "").trim();
  const match = text.match(/\d[\d.]*\d|\d/);

  return {
    ok: true,
    rawText: text,
    reading: match ? match[0] : null,
  };
}

function buildOcrPrompt(unitHint) {
  return unitHint
    ? `You are reading a photo of a digital display or gauge. Reply with ONLY the numeric reading shown next to or associated with "${unitHint}" - no words, no units, just the number (for example: 2347.6). If you cannot find a reading for "${unitHint}", reply with exactly: NONE`
    : `You are reading a photo of a digital display or gauge. Reply with ONLY the main numeric reading shown - no words, no units, just the number. If there are several numbers, pick the single most prominent reading. If you cannot read a number, reply with exactly: NONE`;
}

function extractReading(text) {
  const match = text.match(/\d[\d.]*\d|\d/);
  return match ? match[0] : null;
}

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-1.5-flash";

async function readNumberFromImageWithGemini(imageBase64, unitHint) {
  if (!imageBase64) {
    throw new Error("No image was provided.");
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
  const geminiResponse = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [
        {
          parts: [{ text: buildOcrPrompt(unitHint) }, { inline_data: { mime_type: "image/jpeg", data: imageBase64 } }],
        },
      ],
    }),
  });

  const data = await geminiResponse.json();
  if (!geminiResponse.ok) {
    throw new Error(data?.error?.message || `Gemini request failed with status ${geminiResponse.status}.`);
  }

  const text = String(data?.candidates?.[0]?.content?.parts?.[0]?.text || "").trim();
  return { ok: true, rawText: text, reading: extractReading(text) };
}

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || "";
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || "google/gemma-3-12b-it";

async function readNumberFromImageWithOpenRouter(imageBase64, unitHint) {
  if (!imageBase64) {
    throw new Error("No image was provided.");
  }

  const openRouterResponse = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OPENROUTER_API_KEY}`,
    },
    body: JSON.stringify({
      model: OPENROUTER_MODEL,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: buildOcrPrompt(unitHint) },
            { type: "image_url", image_url: { url: `data:image/jpeg;base64,${imageBase64}` } },
          ],
        },
      ],
    }),
  });

  const data = await openRouterResponse.json();
  if (!openRouterResponse.ok) {
    throw new Error(data?.error?.message || `OpenRouter request failed with status ${openRouterResponse.status}.`);
  }

  const text = String(data?.choices?.[0]?.message?.content || "").trim();
  return { ok: true, rawText: text, reading: extractReading(text) };
}

function readNumberFromImage(imageBase64, unitHint) {
  if (OPENROUTER_API_KEY) {
    return readNumberFromImageWithOpenRouter(imageBase64, unitHint);
  }
  if (GEMINI_API_KEY) {
    return readNumberFromImageWithGemini(imageBase64, unitHint);
  }
  return readNumberFromImageWithOllama(imageBase64, unitHint);
}

const server = http.createServer((request, response) => {
  if (request.method === "OPTIONS") {
    setCorsHeaders(response, request);
    response.writeHead(204);
    response.end();
    return;
  }

  if (request.url === "/api/leave-data") {
    setCorsHeaders(response, request);
    fetchLeaveData()
      .then((cache) => {
        response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        response.end(JSON.stringify({ records: cache.data || [], error: cache.error || null }));
      })
      .catch((error) => {
        response.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
        response.end(JSON.stringify({ records: [], error: error.message || "Could not load leave data" }));
      });
    return;
  }

  if (request.url === "/api/login" && request.method === "POST") {
    setCorsHeaders(response, request);
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1024 * 1024) {
        request.destroy();
      }
    });
    request.on("end", () => {
      let payload;
      try {
        payload = JSON.parse(body);
      } catch (error) {
        response.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        response.end(JSON.stringify({ ok: false, reason: "invalid_request" }));
        return;
      }

      const email = String(payload.email || "").trim().toLowerCase();
      const password = String(payload.password || "").trim();
      const users = readUsersWithPasswords();
      const matchedUser = users.find((user) => matchesUserEmail(user, email));

      if (!matchedUser) {
        response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        response.end(JSON.stringify({ ok: false, reason: "not_found" }));
        return;
      }
      // Temporary sign-in bypass: any existing email can log in, regardless
      // of the submitted password, until the user-password migration is fixed.

      const { password: _omit, ...safeUser } = matchedUser;
      const token = createSession(safeUser.email);
      response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ ok: true, user: safeUser, token }));
    });
    return;
  }

  // Public (no session token) since the person submitting this hasn't
  // logged in yet — admin-mediated reset: this just queues a request for
  // Asha to see and action, there's no email service to send a reset link.
  if (request.url === "/api/forgot-password" && request.method === "POST") {
    setCorsHeaders(response, request);
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1024 * 1024) {
        request.destroy();
      }
    });
    request.on("end", () => {
      let payload;
      try {
        payload = JSON.parse(body);
      } catch (error) {
        response.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        response.end(JSON.stringify({ ok: false, reason: "invalid_request" }));
        return;
      }

      const email = String(payload.email || "").trim().toLowerCase();
      const users = readUsersWithPasswords();
      const matchedUser = users.find((user) => matchesUserEmail(user, email));

      if (!matchedUser) {
        response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        response.end(JSON.stringify({ ok: false, reason: "not_found" }));
        return;
      }

      const requests = readStoreValue("passwordResetRequests");
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
        writeStoreValue("passwordResetRequests", requests);
      }

      response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ ok: true }));
    });
    return;
  }

  if (request.url === "/api/logout" && request.method === "POST") {
    setCorsHeaders(response, request);
    deleteSession(getBearerToken(request));
    response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ ok: true }));
    return;
  }

  if (request.url === "/api/checklist-sheet-submission" && request.method === "POST") {
    setCorsHeaders(response, request);
    if (!getSessionEmail(getBearerToken(request))) {
      response.writeHead(401, { "Content-Type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ error: "Unauthorized. Please sign in again." }));
      return;
    }

    parseJsonBody(request)
      .then((payload) => appendChecklistSubmission(ROOT, payload))
      .then((result) => {
        response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        response.end(JSON.stringify({ ok: true, ...result }));
      })
      .catch((error) => {
        response.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
        response.end(JSON.stringify({ ok: false, error: error.message || "Could not export checklist submission" }));
      });
    return;
  }

  if (request.url === "/api/submission-report-sync" && request.method === "POST") {
    setCorsHeaders(response, request);
    if (!getSessionEmail(getBearerToken(request))) {
      response.writeHead(401, { "Content-Type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ ok: false, error: "Unauthorized. Please sign in again." }));
      return;
    }

    // Rows are computed here from the store's own data, not trusted from the
    // client — see lib/submission-audit.js for why.
    Promise.resolve()
      .then(() => {
        const tasks = readStoreValue("tasks");
        const completions = readStoreValue("completions");
        const users = readStoreValue("users");
        return {
          reportRows: buildSubmissionAuditRows(tasks, completions, users),
          detailsPayload: { tasks, completions, users },
        };
      })
      .then(({ reportRows, detailsPayload }) =>
        Promise.all([
          rewriteSubmissionReport(ROOT, reportRows),
          rewriteSubmittedTaskDetailsSheet(ROOT, detailsPayload),
        ])
      )
      .then(([reportResult, detailsResult]) => {
        response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        response.end(
          JSON.stringify({
            ...reportResult,
            detailsRowCount: detailsResult?.rowCount ?? 0,
            detailsSheetTitle: detailsResult?.sheetTitle || "",
            detailsSpreadsheetUrl: detailsResult?.spreadsheetUrl || "",
            detailsSkipped: Boolean(detailsResult?.skipped),
          })
        );
      })
      .catch((error) => {
        response.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
        response.end(JSON.stringify({ ok: false, error: error.message || "Could not sync the submission report." }));
      });
    return;
  }

  if (request.url === "/api/users-sheet-sync" && request.method === "POST") {
    setCorsHeaders(response, request);
    if (!getSessionEmail(getBearerToken(request))) {
      response.writeHead(401, { "Content-Type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ error: "Unauthorized. Please sign in again." }));
      return;
    }

    parseJsonBody(request)
      .then((payload) => syncUsersSheet(ROOT, payload.users))
      .then((result) => {
        response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        response.end(JSON.stringify({ ok: true, ...result }));
      })
      .catch((error) => {
        response.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
        response.end(JSON.stringify({ ok: false, error: error.message || "Could not sync users sheet" }));
      });
    return;
  }

  if (request.url.startsWith("/api/vehicle-assignment") && request.method === "GET") {
    setCorsHeaders(response, request);
    const sessionEmail = getSessionEmail(getBearerToken(request));
    if (!sessionEmail) {
      response.writeHead(401, { "Content-Type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ ok: false, error: "Unauthorized. Please sign in again." }));
      return;
    }

    lookupVehicleAssignment(ROOT, sessionEmail)
      .then((result) => {
        response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        response.end(JSON.stringify({ ok: true, email: sessionEmail, ...result }));
      })
      .catch((error) => {
        response.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
        response.end(
          JSON.stringify({
            ok: false,
            error: error.message || "Could not load vehicle assignment",
            shareWith: getServiceAccountEmail(ROOT),
          })
        );
      });
    return;
  }

  if (request.url === "/api/ocr-read-number" && request.method === "POST") {
    setCorsHeaders(response, request);
    if (!getSessionEmail(getBearerToken(request))) {
      response.writeHead(401, { "Content-Type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ ok: false, error: "Unauthorized. Please sign in again." }));
      return;
    }

    parseJsonBody(request, 12 * 1024 * 1024)
      .then((payload) => readNumberFromImage(payload.imageBase64, payload.unitHint))
      .then((result) => {
        response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        response.end(JSON.stringify(result));
      })
      .catch((error) => {
        response.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
        response.end(JSON.stringify({ ok: false, error: error.message || "Could not read the image." }));
      });
    return;
  }

  // Read-only export for external tools (Google Apps Script / Looker
  // Studio) that can't use the normal user-login token flow. Gated by its
  // own long random secret (never a real user's credentials), and never
  // includes passwords.
  if (request.url.startsWith("/api/sheets-feed")) {
    setCorsHeaders(response, request);
    const requestUrl = new URL(request.url, "http://localhost");
    const key = requestUrl.searchParams.get("key");
    if (key !== SHEETS_FEED_SECRET) {
      response.writeHead(401, { "Content-Type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ error: "Invalid or missing key" }));
      return;
    }
    const feed = readAllStore();
    feed.buddyAssignments = BUDDY_ASSIGNMENTS;
    response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    response.end(JSON.stringify(feed));
    return;
  }

  if (request.url.startsWith("/api/checklist-questions")) {
    setCorsHeaders(response, request);
    const requestUrl = new URL(request.url, "http://localhost");
    const key = requestUrl.searchParams.get("key");
    if (key !== SHEETS_FEED_SECRET) {
      response.writeHead(401, { "Content-Type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ error: "Invalid or missing key" }));
      return;
    }
    const title = requestUrl.searchParams.get("title") || "";
    response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    response.end(JSON.stringify(getChecklistQuestionsForTitle(title)));
    return;
  }

  if (request.url === "/api/client-form-submissions" && request.method === "POST") {
    setCorsHeaders(response, request);
    const firestoreDb = getClientFormFirestore();
    if (!firestoreDb) {
      response.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ ok: false, error: "Form storage is not configured on this server." }));
      return;
    }
    let pendingSubmission = null;
    parseJsonBody(request)
      .then((payload) => {
        pendingSubmission = { ...payload, submittedAt: new Date().toISOString() };
        return firestoreDb.collection(CLIENT_FORM_SUBMISSIONS_COLLECTION).add(pendingSubmission);
      })
      .then((docRef) => {
        response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        response.end(JSON.stringify({ ok: true, id: docRef.id }));
        // Best-effort — Firestore is already the source of truth, so a
        // sheet-export hiccup shouldn't affect the response already sent.
        return appendClientFormSubmissionRow(ROOT, pendingSubmission).catch((error) => {
          console.error("Could not export client form submission to Sheets:", error.message);
        });
      })
      .catch((error) => {
        response.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        response.end(JSON.stringify({ ok: false, error: error.message || "Could not save the submission." }));
      });
    return;
  }

  if (request.url === "/api/client-form-submissions" && request.method === "GET") {
    setCorsHeaders(response, request);
    if (!getSessionEmail(getBearerToken(request))) {
      response.writeHead(401, { "Content-Type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ ok: false, error: "Unauthorized. Please sign in again." }));
      return;
    }
    const firestoreDb = getClientFormFirestore();
    if (!firestoreDb) {
      response.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ ok: false, error: "Form storage is not configured on this server." }));
      return;
    }
    firestoreDb
      .collection(CLIENT_FORM_SUBMISSIONS_COLLECTION)
      .orderBy("submittedAt", "desc")
      .limit(200)
      .get()
      .then((snapshot) => {
        const submissions = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
        response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        response.end(JSON.stringify({ ok: true, submissions }));
      })
      .catch((error) => {
        response.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
        response.end(JSON.stringify({ ok: false, error: error.message || "Could not load submissions." }));
      });
    return;
  }

  const storeKeyMatch = request.url.match(/^\/api\/store\/([a-zA-Z]+)$/);
  const isStoreRoute = request.url === "/api/store" || Boolean(storeKeyMatch);
  if (isStoreRoute && !getSessionEmail(getBearerToken(request))) {
    setCorsHeaders(response, request);
    response.writeHead(401, { "Content-Type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ error: "Unauthorized. Please sign in again." }));
    return;
  }

  if (request.url === "/api/store" && request.method === "GET") {
    setCorsHeaders(response, request);
    response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    response.end(JSON.stringify(readAllStore()));
    return;
  }

  if (storeKeyMatch) {
    const key = storeKeyMatch[1];
    if (!STORE_KEYS.includes(key)) {
      response.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ error: "Unknown store key" }));
      return;
    }

    if (request.method === "GET") {
      setCorsHeaders(response, request);
      const value = key === "users" ? stripPasswords(readStoreValue(key)) : readStoreValue(key);
      response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      response.end(JSON.stringify(value));
      return;
    }

    if (request.method === "PUT") {
      setCorsHeaders(response, request);
      let body = "";
      request.on("data", (chunk) => {
        body += chunk;
        if (body.length > 20 * 1024 * 1024) {
          request.destroy();
        }
      });
      request.on("end", () => {
        try {
          let value = JSON.parse(body);
          if (key === "users") {
            value = preserveExistingPasswords(value);
          }
          writeStoreValue(key, value);
          response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
          response.end(JSON.stringify({ ok: true }));
        } catch (error) {
          response.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
          response.end(JSON.stringify({ error: "Invalid JSON body" }));
        }
      });
      return;
    }

    response.writeHead(405, { "Content-Type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ error: "Method not allowed" }));
    return;
  }

  const pathOnly = request.url.split("?")[0].split("#")[0];
  const urlPath = pathOnly === "/" ? "/index.html" : pathOnly;
  const safePath = path.normalize(urlPath).replace(/^(\.\.[/\\])+/, "");
  const filePath = path.join(ROOT, safePath);

  if (!filePath.startsWith(ROOT)) {
    response.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Forbidden");
    return;
  }

  fs.readFile(filePath, (error, file) => {
    if (error) {
      if (error.code === "ENOENT") {
        response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        response.end("Not found");
        return;
      }

      response.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Server error");
      return;
    }

    const extension = path.extname(filePath).toLowerCase();
    response.writeHead(200, {
      "Content-Type": MIME_TYPES[extension] || "application/octet-stream",
    });
    response.end(file);
  });
});

startServer(DEFAULT_PORT);

function startServer(port) {
  server.listen(port, () => {
    console.log(`MoTrack app running at http://localhost:${server.address().port}`);
    console.log(`Sheets feed secret (data/sheets-feed-secret.txt): ${SHEETS_FEED_SECRET}`);
  });
}

server.on("error", (error) => {
  if (error.code === "EADDRINUSE") {
    const nextPort = Number(error.port || DEFAULT_PORT) + 1;
    console.log(`Port ${error.port || DEFAULT_PORT} is busy, trying ${nextPort}...`);
    server.listen(nextPort);
    return;
  }

  throw error;
});
