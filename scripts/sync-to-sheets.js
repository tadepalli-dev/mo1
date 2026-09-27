// Pushes MoTrack's current database contents to a Google Sheet, so tools
// like Looker Studio (which can't reach this machine's localhost server or
// its SQLite file directly) can read the data from Sheets instead.
//
// Setup (one-time, see README-sheets-sync.md for the full walkthrough):
//   1. Create a Google Cloud service account with the Sheets API enabled,
//      download its JSON key, save it in this project (do not commit it).
//   2. Share the target Google Sheet with the service account's email
//      (the "client_email" field in the key file) as an Editor.
//   3. Copy sheets-config.example.json to sheets-config.json and fill in
//      the spreadsheet ID (from the sheet's URL) and the key file path.
//
// Run with: node scripts/sync-to-sheets.js

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { DatabaseSync } = require("node:sqlite");
const admin = require("firebase-admin");
const { getFirestore } = require("firebase-admin/firestore");
const firestoreStore = require("../lib/firestore-store");

const ROOT = path.join(__dirname, "..");
const CONFIG_PATH = path.join(ROOT, "sheets-config.json");
const SHEETS_API_SCOPE = "https://www.googleapis.com/auth/spreadsheets";
const FIRESTORE_STORE_COLLECTION = "motrack_store";
const EXPORTED_STORE_KEYS = ["users", "tasks", "completions", "absences", "pantryAlerts"];

function loadConfig() {
  const spreadsheetId = String(process.env.GOOGLE_SHEETS_SPREADSHEET_ID || "").trim();
  if (spreadsheetId) {
    return { spreadsheetId, serviceAccountKeyPath: null };
  }
  if (!fs.existsSync(CONFIG_PATH)) {
    console.error(
      `Missing ${CONFIG_PATH}.\n` +
        `Copy sheets-config.example.json to sheets-config.json and fill in your spreadsheet ID and service account key path. See README-sheets-sync.md.`
    );
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
}

function loadServiceAccount(config) {
  const fromEnvironment = String(process.env.GOOGLE_SHEETS_SERVICE_ACCOUNT || "").trim();
  if (fromEnvironment) {
    try {
      return JSON.parse(fromEnvironment);
    } catch (error) {
      throw new Error(`GOOGLE_SHEETS_SERVICE_ACCOUNT is not valid JSON: ${error.message}`);
    }
  }
  if (!config.serviceAccountKeyPath) {
    throw new Error("Set GOOGLE_SHEETS_SERVICE_ACCOUNT when GOOGLE_SHEETS_SPREADSHEET_ID is used.");
  }
  const keyPath = path.resolve(ROOT, config.serviceAccountKeyPath);
  if (!fs.existsSync(keyPath)) {
    console.error(`Service account key file not found at: ${keyPath}`);
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(keyPath, "utf8"));
}

function base64url(input) {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

async function getAccessToken(serviceAccount) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const claims = {
    iss: serviceAccount.client_email,
    scope: SHEETS_API_SCOPE,
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  };

  const unsigned = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claims))}`;
  const signer = crypto.createSign("RSA-SHA256");
  signer.update(unsigned);
  signer.end();
  const signature = signer.sign(serviceAccount.private_key);
  const jwt = `${unsigned}.${base64url(signature)}`;

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(`Could not get a Google access token: ${JSON.stringify(data)}`);
  }
  return data.access_token;
}

function readStore() {
  const dbPath = path.join(ROOT, "data", "motrack.db");
  if (!fs.existsSync(dbPath)) {
    throw new Error(`No database found at ${dbPath}. Start the MoTrack server at least once first.`);
  }
  const db = new DatabaseSync(dbPath);
  const getStatement = db.prepare("SELECT value FROM kv_store WHERE key = ?");
  const read = (key, fallback) => {
    const row = getStatement.get(key);
    if (!row) return fallback;
    try {
      return JSON.parse(row.value) ?? fallback;
    } catch (error) {
      return fallback;
    }
  };
  const result = {
    users: read("users", []),
    tasks: read("tasks", []),
    completions: read("completions", {}),
    absences: read("absences", {}),
    pantryAlerts: read("pantryAlerts", []),
  };
  db.close();
  return result;
}

function readTargetServiceAccount() {
  const raw = String(
    process.env.CHECKLIST_FIREBASE_SERVICE_ACCOUNT || process.env.FIREBASE_SERVICE_ACCOUNT || ""
  ).trim();
  if (!raw) {
    throw new Error(
      "Missing CHECKLIST_FIREBASE_SERVICE_ACCOUNT or FIREBASE_SERVICE_ACCOUNT for the checklist-dashboard Firestore project."
    );
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`Checklist Firebase credential is not valid JSON: ${error.message}`);
  }
}

async function readStoreFromFirestore() {
  const app = admin.initializeApp(
    { credential: admin.cert(readTargetServiceAccount()) },
    "checklist-sheets-export"
  );
  const firestore = getFirestore(app);
  const entries = await Promise.all(
    EXPORTED_STORE_KEYS.map(async (key) => [
      key,
      await firestoreStore.readStoreValue(firestore, FIRESTORE_STORE_COLLECTION, key, key === "completions" ? {} : []),
    ])
  );
  return Object.fromEntries(entries);
}

// Converts an array of (possibly differently-shaped) plain objects into a
// header row + data rows, using the union of all keys seen. Nested
// objects/arrays are stringified so they still fit in a single cell.
function objectsToRows(items) {
  const headerSet = new Set();
  items.forEach((item) => Object.keys(item).forEach((key) => headerSet.add(key)));
  const headers = [...headerSet];
  const rows = items.map((item) =>
    headers.map((key) => {
      const value = item[key];
      if (value === undefined || value === null) {
        return "";
      }
      if (typeof value === "object") {
        return JSON.stringify(value);
      }
      return String(value);
    })
  );
  return [headers, ...rows];
}

// The checklist creates one task per standard checklist item, but the Sheet
// needs one clear handover row per customer.  Group those task copies by the
// immutable walk-in ID while retaining the assigned salesperson and customer
// details that came from the main Firebase project.
function buildWalkinAssignmentRows(tasks) {
  const assignments = new Map();
  tasks
    .filter((task) => task && task.source === "walkin")
    .forEach((task) => {
      const walkinId = String(task.walkinId || task.customerAttributionKey || task.taskId || task.id || "").trim();
      if (!walkinId) {
        return;
      }
      const existing = assignments.get(walkinId);
      if (existing) {
        existing.checklistTaskCount += 1;
        return;
      }
      assignments.set(walkinId, {
        walkinId,
        customerName: task.customerName || task.customerAttributionName || "",
        assignedSalesperson: task.assigneeName || "",
        assignedSalespersonEmail: task.assigneeEmail || "",
        department: task.department || "",
        details: task.details || "",
        assignedAt: task.createdAt || "",
        plannedDate: task.plannedDate || task.walkinDate || "",
        checklistTaskCount: 1,
      });
    });
  return [...assignments.values()];
}

async function getSpreadsheetMeta(token, spreadsheetId) {
  const response = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(`Could not read the spreadsheet (check the ID and that it's shared with the service account): ${JSON.stringify(data)}`);
  }
  return data;
}

async function ensureTabsExist(token, spreadsheetId, existingTitles, wantedTitles) {
  const missing = wantedTitles.filter((title) => !existingTitles.includes(title));
  if (!missing.length) {
    return;
  }
  const requests = missing.map((title) => ({ addSheet: { properties: { title } } }));
  const response = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}:batchUpdate`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ requests }),
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(`Could not create sheet tabs (${missing.join(", ")}): ${JSON.stringify(data)}`);
  }
}

async function writeTab(token, spreadsheetId, title, rows) {
  // A1 notation requires sheet names containing spaces (or other special
  // characters) to be wrapped in single quotes, e.g. 'Pantry Alerts'!A1.
  const range = encodeURIComponent(`'${title}'`);

  await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${range}:clear`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });

  const response = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${range}!A1?valueInputOption=RAW`,
    {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ values: rows }),
    }
  );
  const data = await response.json();
  if (!response.ok) {
    throw new Error(`Could not write to the "${title}" tab: ${JSON.stringify(data)}`);
  }
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  // Render's scheduled job has no persistent local SQLite file.  Reading the
  // checklist Firestore destination keeps Sheets in sync with the same data
  // the hosted dashboard uses.  The original local mode remains available.
  const store = process.argv.includes("--from-firestore") ? await readStoreFromFirestore() : readStore();

  // Never export passwords into the Sheet — it may end up shared more
  // broadly (e.g. as a Looker Studio data source) than the app itself.
  const usersWithoutPasswords = store.users.map(({ password, ...rest }) => rest);

  // Walk-in customer checklist clones (one set per customer handed to a
  // salesman that day) dwarf the actual employee task list in row count and
  // carry customer/walk-in fields that don't apply to a plain employee task
  // — keep this tab to genuinely assigned employee tasks only.
  const employeeTasks = store.tasks.filter((task) => task.source !== "walkin");
  const walkinAssignments = buildWalkinAssignmentRows(store.tasks);

  // state.pantryAlerts is unshift()'d in the app (newest submission first),
  // which reads backwards for a report meant to be read top-to-bottom —
  // oldest submission first, so e.g. all of Kamal's rows appear in the order
  // he actually submitted them, earliest at the top.
  const pantryAlertsChronological = [...store.pantryAlerts].sort(
    (left, right) => new Date(left.submittedAt) - new Date(right.submittedAt)
  );

  const tabs = {
    Tasks: objectsToRows(employeeTasks),
    "Walk-in Assignments": objectsToRows(walkinAssignments),
    Completions: objectsToRows(
      Object.entries(store.completions).map(([key, value]) => ({ completionKey: key, ...value }))
    ),
    Users: objectsToRows(usersWithoutPasswords),
    "Pantry Alerts": objectsToRows(pantryAlertsChronological),
  };

  if (dryRun) {
    console.log("--dry-run: not contacting Google, just showing what would be synced.\n");
    for (const [title, rows] of Object.entries(tabs)) {
      console.log(`=== ${title} (${Math.max(rows.length - 1, 0)} row(s)) ===`);
      console.log(`Columns: ${rows[0] ? rows[0].join(", ") : "(none)"}`);
      if (rows[1]) {
        console.log(`First row: ${JSON.stringify(rows[1])}`);
      }
      console.log();
    }
    return;
  }

  const config = loadConfig();
  const serviceAccount = loadServiceAccount(config);
  const token = await getAccessToken(serviceAccount);

  const meta = await getSpreadsheetMeta(token, config.spreadsheetId);
  const existingTitles = meta.sheets.map((sheet) => sheet.properties.title);
  await ensureTabsExist(token, config.spreadsheetId, existingTitles, Object.keys(tabs));

  for (const [title, rows] of Object.entries(tabs)) {
    const safeRows = rows.length ? rows : [["(no data yet)"]];
    await writeTab(token, config.spreadsheetId, title, safeRows);
    console.log(`Synced ${Math.max(rows.length - 1, 0)} row(s) to "${title}"`);
  }

  console.log(`Done. View it at: https://docs.google.com/spreadsheets/d/${config.spreadsheetId}/edit`);
}

main().catch((error) => {
  console.error("Sync failed:", error.message);
  process.exit(1);
});
