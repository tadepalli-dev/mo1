const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { DatabaseSync } = require("node:sqlite");
const { Readable } = require("node:stream");
const admin = require("firebase-admin");
const { getFirestore } = require("firebase-admin/firestore");
const { get, put } = require("@vercel/blob");
const { rewriteSubmittedTaskDetailsSheet } = require("../lib/submitted-task-details-export");
const {
  CHECKLIST_ATTACHMENT_PREFIX,
  buildChecklistAttachmentUrl,
  hasValidAttachmentSignature,
  isChecklistAttachmentPath,
} = require("../lib/checklist-attachment-links");
const { appendChecklistSubmission, syncUsersSheet } = require("../lib/checklist-sheet-export");
const { rewriteSubmissionReport } = require("../lib/submission-report-export");
const { buildSubmissionAuditRows } = require("../lib/submission-audit");
const {
  getServiceAccountEmail,
  listVehicleAssignments,
  lookupVehicleAssignment,
} = require("../lib/vehicle-sheet-directory");
const { appendClientFormSubmissionRow } = require("../lib/client-form-sheet-export");
const firestoreStore = require("../lib/firestore-store");

const ROOT = process.cwd();
const BUNDLED_DATA_DIR = path.join(ROOT, "data");
const TMP_DATA_DIR = path.join("/tmp", "motrack-data");
const TMP_DB_PATH = path.join(TMP_DATA_DIR, "motrack.db");
const BUNDLED_DB_PATH = path.join(BUNDLED_DATA_DIR, "motrack.db");
const BUNDLED_SHEETS_SECRET_PATH = path.join(BUNDLED_DATA_DIR, "sheets-feed-secret.txt");
const TMP_SHEETS_SECRET_PATH = path.join(TMP_DATA_DIR, "sheets-feed-secret.txt");
const SERVICE_ACCOUNT_PATH = path.join(ROOT, "service-account-key.json");
const FIRESTORE_STORE_COLLECTION = "motrack_store";
// Client form submissions get their own Firestore collection (one document
// per submission) rather than a STORE_KEYS array, because a shared array
// eventually exceeds Firestore's ~1MB per-field limit — the exact failure
// hit earlier with the "tasks" store key. A collection only grows in
// document count, never in per-document size, so that ceiling can't recur.
const CLIENT_FORM_SUBMISSIONS_COLLECTION = "client_form_submissions";
const MAX_CHECKLIST_ATTACHMENT_BYTES = 3 * 1024 * 1024;
const RETIRED_LOGIN_EMAILS = new Set(["ups021980@gmail.com"]);
const SITE_VISIT_COUNT = 10;

const STORE_KEYS = ["users", "tasks", "deletedRequiredTasks", "completions", "absences", "pantryAlerts", "liveLocations", "passwordResetRequests", "vehicleChangeRequests", "vehicleAllocations", "checklistFollowUps"];
const STORE_DEFAULTS = {
  users: [],
  tasks: [],
  deletedRequiredTasks: [],
  completions: {},
  absences: {},
  pantryAlerts: [],
  liveLocations: {},
  passwordResetRequests: [],
  vehicleChangeRequests: [],
  vehicleAllocations: {},
  checklistFollowUps: {},
};
const CASHIER_EMAIL = "dilip.gupta@curtainsandcarpets.com";
const LEGACY_HRULLEKHA_EMAIL = "hrullekha@modesigns.in";
const TADEPALLI_EMAIL = "tadepalli@modesigns.in";

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
    // Not admin.apps.length — this firebase-admin version doesn't expose
    // .apps as a property (only the getApps() function), so that check
    // throws instead of ever returning false, silently falling through to
    // the catch below and permanently disabling Firestore for the rest of
    // this process's life. That's why production has been serving a frozen
    // snapshot from the last deploy instead of live data.
    if (!admin.getApps().length) {
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
    const json = await withTimeout(
      firestoreStore.readStoreJson(firestoreDb, FIRESTORE_STORE_COLLECTION, key),
      8000,
      `Firestore read for ${key}`
    );
    if (json === null) {
      return readStoreValue(key);
    }

    const parsed = JSON.parse(json);
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
      firestoreStore.writeStoreValue(firestoreDb, FIRESTORE_STORE_COLLECTION, key, value),
      15000,
      `Firestore write for ${key}`
    );
    // Keep the bundled-snapshot fallback in step with Firestore so a later
    // Firestore outage degrades to recent data rather than deploy-time data.
    writeStoreValue(key, value);
    return true;
  } catch (error) {
    // This fallback writes to /tmp on Vercel, which is per-instance and
    // wiped between cold starts — it keeps the current request working but
    // the data is effectively lost, so the caller reports it rather than
    // answering a plain "ok".
    console.error(`Firestore write failed for "${key}", using SQLite fallback.`, error);
    writeStoreValue(key, value);
    return false;
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

async function migrateTadepalliUserEmail(users) {
  const legacyUser = users.find((user) => normalizeEmail(user.email) === LEGACY_HRULLEKHA_EMAIL);
  const replacementExists = users.some((user) => normalizeEmail(user.email) === TADEPALLI_EMAIL);
  if (!legacyUser || replacementExists) {
    return users;
  }

  legacyUser.email = TADEPALLI_EMAIL;
  await writeStoreValueAsync("users", users);
  return users;
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
    if (!email || RETIRED_LOGIN_EMAILS.has(email) || Number.isNaN(expiresAt) || expiresAt < Date.now()) {
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

function safeAttachmentName(value) {
  return String(value || "attachment")
    .replace(/[^a-zA-Z0-9._-]/g, "-")
    .replace(/-+/g, "-")
    .slice(-120);
}

function safeAttachmentMimeType(value) {
  const mimeType = String(value || "application/octet-stream").toLowerCase();
  return mimeType.startsWith("image/") || mimeType === "application/pdf" ? mimeType : "application/octet-stream";
}

async function handleChecklistAttachmentUpload(request, response) {
  if (!isAuthorized(request)) {
    sendJson(response, 401, { ok: false, error: "Unauthorized. Please sign in again." });
    return;
  }

  const payload = await parseJsonBody(request);
  const fileBuffer = Buffer.from(String(payload.data || ""), "base64");
  if (!fileBuffer.length || fileBuffer.length > MAX_CHECKLIST_ATTACHMENT_BYTES) {
    sendJson(response, 400, { ok: false, error: "Each image, PDF, or screenshot must be smaller than 3 MB." });
    return;
  }

  const userFolder = safeAttachmentName(getSessionEmailFromToken(getBearerToken(request)) || "employee");
  const blob = await put(`${CHECKLIST_ATTACHMENT_PREFIX}${userFolder}/${Date.now()}-${safeAttachmentName(payload.name)}`, fileBuffer, {
    access: "private",
    addRandomSuffix: true,
    contentType: safeAttachmentMimeType(payload.type),
  });

  sendJson(response, 200, {
    ok: true,
    name: String(payload.name || "attachment"),
    pathname: blob.pathname,
    contentType: blob.contentType,
    size: fileBuffer.length,
  });
}

async function handleChecklistAttachmentDownload(request, response, pathname, signature) {
  const hasSignedSheetLink = hasValidAttachmentSignature(pathname, signature, process.env.BLOB_READ_WRITE_TOKEN);
  if (!isAuthorized(request) && !hasSignedSheetLink) {
    sendJson(response, 401, { ok: false, error: "Unauthorized. Please sign in again." });
    return;
  }
  if (!isChecklistAttachmentPath(pathname)) {
    sendJson(response, 400, { ok: false, error: "Invalid attachment." });
    return;
  }

  const result = await get(pathname, { access: "private" });
  if (!result || result.statusCode !== 200 || !result.stream) {
    sendJson(response, 404, { ok: false, error: "Attachment not found." });
    return;
  }

  response.status(200);
  response.setHeader("Content-Type", result.blob.contentType || "application/octet-stream");
  response.setHeader("Content-Disposition", "inline");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Cache-Control", "private, no-store");
  Readable.fromWeb(result.stream).pipe(response);
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
  let users = await readUsersWithPasswordsAsync();
  users = await migrateTadepalliUserEmail(users);
  const matchedUser = users.find((user) => matchesUserEmail(user, email));

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
  const matchedUser = users.find((user) => matchesUserEmail(user, email));

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

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function isHrApprover(user) {
  return normalizeEmail(user?.email) === "kamal@modesigns.in";
}

// The workflow runs installer -> Kamal (allocates the vehicle) -> Dilip
// (releases the cash) -> back to the installer, who collects the vehicle.
const VEHICLE_REQUEST_OPEN_STATUSES = ["pending_allocation", "pending_cash"];

// An earlier version ran the two desks the other way round, so requests
// already in the store carry the old status names. Both of those mean nobody
// has allocated a vehicle under the current rules, so they land back with Kamal
// rather than being stranded in a status no panel renders.
function normalizeVehicleRequestStatus(status) {
  const value = String(status || "").trim();
  if (value === "pending_cashier" || value === "pending_hr") {
    return "pending_allocation";
  }
  return value;
}

// A stale board (or a double click) retries a step the request has already
// moved past. Naming the stage it actually reached beats a blanket refusal.
function describeVehicleStageConflict(status, expected) {
  if (status === "pending_allocation") {
    return "This request is still waiting for Kamal to allocate a vehicle.";
  }
  if (status === "pending_cash") {
    return expected === "pending_allocation"
      ? "This request has already been allocated and is now with Dilip for the cash."
      : "This request is still waiting for Dilip to release the cash.";
  }
  if (status === "allotted") {
    return "This request is already complete - the vehicle has been handed over.";
  }
  if (status === "rejected") {
    return "This request was already rejected.";
  }
  return "This request cannot be updated at this stage.";
}

async function getSessionUser(request) {
  const email = getSessionEmailFromToken(getBearerToken(request));
  if (!email) {
    return null;
  }
  const users = await readUsersWithPasswordsAsync();
  return users.find((user) => normalizeEmail(user.email) === email) || null;
}

async function getLiveVehicleDirectory() {
  const [directory, allocations, users] = await Promise.all([
    listVehicleAssignments(ROOT),
    readStoreValueAsync("vehicleAllocations"),
    readUsersWithPasswordsAsync(),
  ]);
  const activeAllocations = allocations && typeof allocations === "object" ? allocations : {};
  const usersByEmail = new Map(users.map((user) => [normalizeEmail(user.email), user]));
  const assignedByVehicle = new Map();
  Object.values(activeAllocations).forEach((allocation) => {
    if (allocation?.vehicleNumber) {
      assignedByVehicle.set(String(allocation.vehicleNumber).trim().toLowerCase(), allocation);
    }
  });

  return {
    warnings: directory.warnings,
    vehicles: directory.vehicles.map((vehicle) => {
      const allocation = assignedByVehicle.get(vehicle.vehicleNumber.toLowerCase());
      const sourceUser = allocation
        ? usersByEmail.get(normalizeEmail(allocation.employeeEmail))
        : usersByEmail.get(normalizeEmail(vehicle.email));
      return {
        ...vehicle,
        assignedTo: allocation
          ? { email: allocation.employeeEmail, name: allocation.employeeName || sourceUser?.name || allocation.employeeEmail }
          : sourceUser
            ? { email: sourceUser.email, name: sourceUser.name }
            : vehicle.email
              ? { email: vehicle.email, name: vehicle.email }
              : null,
      };
    }),
  };
}

async function handleVehicleChangeRequestCreate(request, response) {
  const user = await getSessionUser(request);
  if (!user) {
    sendJson(response, 401, { ok: false, error: "Unauthorized. Please sign in again." });
    return;
  }

  const payload = await parseJsonBody(request);
  const reason = String(payload.reason || "").trim();
  if (!reason) {
    sendJson(response, 400, { ok: false, error: "Please enter a reason for the vehicle change." });
    return;
  }

  const requests = await readStoreValueAsync("vehicleChangeRequests");
  const hasPendingRequest = requests.some(
    (entry) =>
      normalizeEmail(entry.employeeEmail) === normalizeEmail(user.email) &&
      VEHICLE_REQUEST_OPEN_STATUSES.includes(normalizeVehicleRequestStatus(entry.status))
  );
  if (hasPendingRequest) {
    sendJson(response, 409, { ok: false, error: "Your vehicle-change request is already in progress." });
    return;
  }

  let currentVehicle = null;
  try {
    const allocations = await readStoreValueAsync("vehicleAllocations");
    currentVehicle = allocations?.[normalizeEmail(user.email)] || (await lookupVehicleAssignment(ROOT, user.email)).match;
  } catch (error) {
    // A request can still be raised when the source sheet is temporarily unavailable.
  }

  const entry = {
    id: crypto.randomUUID(),
    employeeEmail: user.email,
    employeeName: user.name || user.email,
    currentVehicleNumber: currentVehicle?.vehicleNumber || "",
    currentVehicleType: currentVehicle?.vehicleType || "",
    reason,
    status: "pending_allocation",
    requestedAt: new Date().toISOString(),
  };
  requests.push(entry);
  const persisted = await writeStoreValueAsync("vehicleChangeRequests", requests);
  sendJson(response, 200, { ok: true, request: entry, persisted });
}

// Kamal picks the vehicle and approves (or rejects). Approving reserves the
// vehicle straight away so it can't be promised twice while the cash step is
// still outstanding, then hands the request to Dilip.
async function handleVehicleChangeRequestAllocate(request, response, requestId) {
  const reviewer = await getSessionUser(request);
  if (!reviewer || !isHrApprover(reviewer)) {
    sendJson(response, 403, { ok: false, error: "Only Kamal can allocate a vehicle for this request." });
    return;
  }

  const payload = await parseJsonBody(request);
  const decision = String(payload.decision || "").toLowerCase();
  if (!["approved", "rejected"].includes(decision)) {
    sendJson(response, 400, { ok: false, error: "Choose approve or reject." });
    return;
  }

  const requests = await readStoreValueAsync("vehicleChangeRequests");
  const entry = requests.find((item) => item.id === requestId);
  if (!entry) {
    sendJson(response, 404, { ok: false, error: "Vehicle-change request not found." });
    return;
  }
  const allocateStatus = normalizeVehicleRequestStatus(entry.status);
  if (allocateStatus !== "pending_allocation") {
    sendJson(response, 409, { ok: false, error: describeVehicleStageConflict(allocateStatus, "pending_allocation") });
    return;
  }

  entry.reviewNote = String(payload.note || "").trim();
  entry.reviewedAt = new Date().toISOString();
  entry.reviewedByEmail = reviewer.email;
  entry.reviewedByName = reviewer.name || reviewer.email;

  if (decision === "rejected") {
    entry.status = "rejected";
    const persisted = await writeStoreValueAsync("vehicleChangeRequests", requests);
    sendJson(response, 200, { ok: true, request: entry, persisted });
    return;
  }

  const requestedVehicleNumber = String(payload.vehicleNumber || "").trim();
  if (!requestedVehicleNumber) {
    sendJson(response, 409, { ok: false, error: "Choose a vehicle before approving this request." });
    return;
  }

  const [allocations, directory] = await Promise.all([
    readStoreValueAsync("vehicleAllocations"),
    getLiveVehicleDirectory(),
  ]);
  const vehicle = directory.vehicles.find(
    (item) => item.vehicleNumber.toLowerCase() === requestedVehicleNumber.toLowerCase()
  );
  if (!vehicle) {
    sendJson(response, 400, { ok: false, error: "The selected vehicle is not in the company vehicle list." });
    return;
  }

  const nextAllocations = allocations && typeof allocations === "object" ? { ...allocations } : {};
  Object.keys(nextAllocations).forEach((email) => {
    if (String(nextAllocations[email]?.vehicleNumber || "").toLowerCase() === vehicle.vehicleNumber.toLowerCase()) {
      delete nextAllocations[email];
    }
  });
  nextAllocations[normalizeEmail(entry.employeeEmail)] = {
    employeeEmail: entry.employeeEmail,
    employeeName: entry.employeeName,
    vehicleNumber: vehicle.vehicleNumber,
    vehicleType: vehicle.vehicleType,
    sourceLabel: "Kamal-approved allocation",
    assignedAt: new Date().toISOString(),
    assignedByEmail: reviewer.email,
    assignedByName: reviewer.name || reviewer.email,
  };

  entry.status = "pending_cash";
  entry.allottedVehicleNumber = vehicle.vehicleNumber;
  entry.allottedVehicleType = vehicle.vehicleType;
  entry.allottedVehiclePreviousHolder = vehicle.assignedTo?.name || "";
  entry.allottedAt = new Date().toISOString();
  entry.allottedByEmail = reviewer.email;
  entry.allottedByName = reviewer.name || reviewer.email;

  await Promise.all([
    writeStoreValueAsync("vehicleChangeRequests", requests),
    writeStoreValueAsync("vehicleAllocations", nextAllocations),
  ]);
  sendJson(response, 200, { ok: true, request: entry, persisted: true });
}

// Dilip hands over the cash, which closes the request and lets the installer
// see the vehicle number to collect.
async function handleVehicleChangeRequestCash(request, response, requestId) {
  const cashier = await getSessionUser(request);
  if (!cashier || normalizeEmail(cashier.email) !== CASHIER_EMAIL) {
    sendJson(response, 403, { ok: false, error: "Only Dilip Gupta, the cashier, can release the cash for this request." });
    return;
  }

  const payload = await parseJsonBody(request);
  const amount = Number(payload.amount);
  if (!Number.isFinite(amount) || amount < 0) {
    sendJson(response, 400, { ok: false, error: "Enter the cash amount handed over." });
    return;
  }

  const requests = await readStoreValueAsync("vehicleChangeRequests");
  const entry = requests.find((item) => item.id === requestId);
  if (!entry) {
    sendJson(response, 404, { ok: false, error: "Vehicle-change request not found." });
    return;
  }
  const cashStatus = normalizeVehicleRequestStatus(entry.status);
  if (cashStatus !== "pending_cash") {
    sendJson(response, 409, { ok: false, error: describeVehicleStageConflict(cashStatus, "pending_cash") });
    return;
  }

  entry.status = "allotted";
  entry.cashAmount = amount;
  entry.cashierNote = String(payload.note || "").trim();
  entry.cashReleasedAt = new Date().toISOString();
  entry.cashReleasedByEmail = cashier.email;
  entry.cashReleasedByName = cashier.name || cashier.email;

  const persisted = await writeStoreValueAsync("vehicleChangeRequests", requests);
  sendJson(response, 200, { ok: true, request: entry, persisted });
}

function createSiteVisitContext(payload) {
  const serialized = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signature = crypto.createHmac("sha256", getSessionSecret()).update(serialized).digest("base64url");
  return `${serialized}.${signature}`;
}

function readSiteVisitContext(token) {
  const [serialized, signature] = String(token || "").split(".");
  if (!serialized || !signature) {
    return null;
  }
  const expected = crypto.createHmac("sha256", getSessionSecret()).update(serialized).digest("base64url");
  if (signature.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
    return null;
  }
  try {
    const payload = JSON.parse(Buffer.from(serialized, "base64url").toString("utf8"));
    return payload && Number(payload.expiresAt) > Date.now() ? payload : null;
  } catch (error) {
    return null;
  }
}

function getSiteVisitCompletionKey(context) {
  const slotKey = context.occurrenceSlot ? `__${context.occurrenceSlot}` : "";
  return `${context.taskId}__${context.occurrenceDate}${slotKey}__visit${context.visitNumber}`;
}

function getSiteVisitParentCompletionKey(context) {
  const slotKey = context.occurrenceSlot ? `__${context.occurrenceSlot}` : "";
  return `${context.taskId}__${context.occurrenceDate}${slotKey}`;
}

function isSiteVisitTaskTitle(title) {
  const normalized = String(title || "").trim().toLowerCase();
  return normalized === "site visit" || normalized === "visit the 10 site";
}

async function handleSiteVisitContextCreate(request, response) {
  const user = await getSessionUser(request);
  if (!user) {
    sendJson(response, 401, { ok: false, error: "Unauthorized. Please sign in again." });
    return;
  }
  const payload = await parseJsonBody(request);
  const taskId = String(payload.taskId || "").trim();
  const occurrenceDate = String(payload.occurrenceDate || "").trim();
  const visitNumber = Number(payload.visitNumber);
  if (!taskId || !/^\d{4}-\d{2}-\d{2}$/.test(occurrenceDate) || !Number.isInteger(visitNumber) || visitNumber < 1 || visitNumber > SITE_VISIT_COUNT) {
    sendJson(response, 400, { ok: false, error: "Invalid site visit details." });
    return;
  }
  const tasks = await readStoreValueAsync("tasks");
  const task = tasks.find((item) => String(item.taskId || item.id || "") === taskId);
  if (!task || normalizeEmail(task.assigneeEmail) !== normalizeEmail(user.email) || !isSiteVisitTaskTitle(task.title)) {
    sendJson(response, 403, { ok: false, error: "You are not allowed to submit this site visit." });
    return;
  }
  const context = createSiteVisitContext({
    taskId,
    occurrenceDate,
    occurrenceSlot: payload.occurrenceSlot || null,
    occurrenceSlotLabel: payload.occurrenceSlotLabel || "",
    visitNumber,
    employeeEmail: user.email,
    employeeName: user.name || user.email,
    expiresAt: Date.now() + 8 * 60 * 60 * 1000,
  });
  sendJson(response, 200, { ok: true, context });
}

async function handleSiteVisitComplete(request, response) {
  let payload;
  try {
    payload = await parseJsonBody(request);
  } catch (error) {
    sendJson(response, 400, { ok: false, error: "Invalid callback payload." });
    return;
  }
  const context = readSiteVisitContext(payload.context);
  if (!context) {
    sendJson(response, 401, { ok: false, error: "The site visit link is invalid or has expired." });
    return;
  }

  const completions = await readStoreValueAsync("completions");
  const completionKey = getSiteVisitCompletionKey(context);
  const submittedAt = new Date().toISOString();
  completions[completionKey] = {
    taskId: context.taskId,
    occurrenceDate: context.occurrenceDate,
    occurrenceSlot: context.occurrenceSlot,
    occurrenceSlotLabel: context.occurrenceSlotLabel,
    visitNumber: context.visitNumber,
    submittedAt,
    responses: {
      openedForm: true,
      externalSubmissionId: String(payload.externalSubmissionId || "").trim(),
      externalImageUrl: String(payload.imageUrl || "").trim(),
    },
  };

  const visits = {};
  for (let number = 1; number <= SITE_VISIT_COUNT; number += 1) {
    const visitKey = getSiteVisitCompletionKey({ ...context, visitNumber: number });
    visits[number] = completions[visitKey] ? completions[visitKey].responses : null;
  }
  if (Object.values(visits).every(Boolean)) {
    completions[getSiteVisitParentCompletionKey(context)] = {
      taskId: context.taskId,
      occurrenceDate: context.occurrenceDate,
      occurrenceSlot: context.occurrenceSlot,
      occurrenceSlotLabel: context.occurrenceSlotLabel,
      submittedAt,
      responses: { visits },
      approvalStatus: "pending",
    };
  }

  const persisted = await writeStoreValueAsync("completions", completions);
  sendJson(response, 200, { ok: true, visitNumber: context.visitNumber, persisted });
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
      const persisted = await writeStoreValueAsync(key, payload);
      sendJson(response, 200, {
        ok: true,
        persisted,
        ...(persisted ? {} : { warning: `"${key}" could not be saved to Firestore and will not survive a restart.` }),
      });
    } catch (error) {
      sendJson(response, 400, { error: "Invalid JSON body" });
    }
    return;
  }

  sendJson(response, 405, { error: "Method not allowed" });
}

// No session check — this is filled in by a walk-in customer on the
// showroom TV, not a logged-in staff member, so there's no session token to
// check (same reasoning as /api/login itself being open).
async function handleClientFormSubmissionCreate(request, response) {
  const firestoreDb = getFirestoreDb();
  if (!firestoreDb) {
    sendJson(response, 500, { ok: false, error: "Form storage is not configured on this server." });
    return;
  }

  let payload;
  try {
    payload = await parseJsonBody(request);
  } catch (error) {
    sendJson(response, 400, { ok: false, error: "Invalid JSON body" });
    return;
  }

  const submission = { ...payload, submittedAt: new Date().toISOString() };
  try {
    const docRef = await firestoreDb.collection(CLIENT_FORM_SUBMISSIONS_COLLECTION).add(submission);
    sendJson(response, 200, { ok: true, id: docRef.id });
  } catch (error) {
    sendJson(response, 500, { ok: false, error: error.message || "Could not save the submission." });
    return;
  }

  // Best-effort — Firestore is already the source of truth for this
  // submission, so a sheet-export hiccup shouldn't affect the response
  // already sent to the customer's browser.
  try {
    await appendClientFormSubmissionRow(ROOT, submission);
  } catch (error) {
    console.error("Could not export client form submission to Sheets:", error.message);
  }
}

async function handleClientFormSubmissionList(request, response) {
  if (!isAuthorized(request)) {
    sendJson(response, 401, { ok: false, error: "Unauthorized. Please sign in again." });
    return;
  }

  const firestoreDb = getFirestoreDb();
  if (!firestoreDb) {
    sendJson(response, 500, { ok: false, error: "Form storage is not configured on this server." });
    return;
  }

  try {
    const snapshot = await firestoreDb
      .collection(CLIENT_FORM_SUBMISSIONS_COLLECTION)
      .orderBy("submittedAt", "desc")
      .limit(200)
      .get();
    const submissions = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
    sendJson(response, 200, { ok: true, submissions });
  } catch (error) {
    sendJson(response, 500, { ok: false, error: error.message || "Could not load submissions." });
  }
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

    if (pathname === "/api/checklist-attachments" && request.method === "POST") {
      await handleChecklistAttachmentUpload(request, response);
      return;
    }

    if (pathname === "/api/checklist-attachment" && request.method === "GET") {
      await handleChecklistAttachmentDownload(request, response, requestUrl.searchParams.get("pathname"), requestUrl.searchParams.get("signature"));
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
        const [tasks, completions, users] = await Promise.all([
          readStoreValueAsync("tasks"),
          readStoreValueAsync("completions"),
          readStoreValueAsync("users"),
        ]);
        const rows = buildSubmissionAuditRows(tasks, completions);
        const attachmentUrlBuilder = (attachmentPath) =>
          buildChecklistAttachmentUrl(attachmentPath, process.env.BLOB_READ_WRITE_TOKEN);
        const [reportResult, detailsResult] = await Promise.all([
          rewriteSubmissionReport(ROOT, rows),
          rewriteSubmittedTaskDetailsSheet(ROOT, { tasks, completions, users }, { attachmentUrlBuilder }),
        ]);
        sendJson(response, 200, {
          ...reportResult,
          detailsRowCount: detailsResult?.rowCount ?? 0,
          detailsSheetTitle: detailsResult?.sheetTitle || "",
          detailsSpreadsheetUrl: detailsResult?.spreadsheetUrl || "",
          detailsSkipped: Boolean(detailsResult?.skipped),
        });
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
        const allocations = await readStoreValueAsync("vehicleAllocations");
        const allocatedVehicle = allocations?.[normalizeEmail(sessionEmail)];
        const result = allocatedVehicle
          ? { match: allocatedVehicle, warnings: [] }
          : await lookupVehicleAssignment(ROOT, sessionEmail);
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

    if (pathname === "/api/site-visit-context" && request.method === "POST") {
      await handleSiteVisitContextCreate(request, response);
      return;
    }

    // Called by the Google Apps Script only after its Sheet and Drive writes
    // succeed. Authentication is the signed, short-lived context in the body.
    if (pathname === "/api/site-visits/complete" && request.method === "POST") {
      await handleSiteVisitComplete(request, response);
      return;
    }

    if (pathname === "/api/vehicle-directory" && request.method === "GET") {
      if (!isAuthorized(request)) {
        sendJson(response, 401, { ok: false, error: "Unauthorized. Please sign in again." });
        return;
      }
      try {
        sendJson(response, 200, { ok: true, ...(await getLiveVehicleDirectory()) });
      } catch (error) {
        sendJson(response, 500, {
          ok: false,
          error: error.message || "Could not load the company vehicle list.",
          shareWith: getServiceAccountEmail(ROOT),
        });
      }
      return;
    }

    if (pathname === "/api/vehicle-change-requests" && request.method === "POST") {
      await handleVehicleChangeRequestCreate(request, response);
      return;
    }

    const vehicleRequestMatch = pathname.match(/^\/api\/vehicle-change-requests\/([^/]+)\/(allocate|cash)$/);
    if (vehicleRequestMatch && request.method === "POST") {
      const [, requestId, action] = vehicleRequestMatch;
      if (action === "allocate") {
        await handleVehicleChangeRequestAllocate(request, response, requestId);
      } else {
        await handleVehicleChangeRequestCash(request, response, requestId);
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

    if (pathname === "/api/client-form-submissions" && request.method === "POST") {
      await handleClientFormSubmissionCreate(request, response);
      return;
    }

    if (pathname === "/api/client-form-submissions" && request.method === "GET") {
      await handleClientFormSubmissionList(request, response);
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
