const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const CHECKLIST_SHEET_CONFIG_PATH = "checklist-sheet-config.json";
const SERVICE_ACCOUNT_FILENAME = "service-account-key.json";
const SHEETS_API_SCOPE = "https://www.googleapis.com/auth/spreadsheets";
const SHEETS_API_BASE = "https://sheets.googleapis.com/v4/spreadsheets";
const EXPORT_TASK_TITLE = "ac checklist";
const INDIA_TIME_ZONE = "Asia/Calcutta";
const DEFAULT_USERS_SHEET_TITLE = "Users";

const HEADER_VALUE_RESOLVERS = {
  timestamp: (submission) => formatSheetTimestamp(submission.submittedAt),
  date: (submission) => formatSheetDate(submission.occurrenceDate || submission.submittedAt),
  "basement carpet a off time": (submission) => getResponseValue(submission, "basement_carpet_a_off_time"),
  "basement carpet b off time": (submission) => getResponseValue(submission, "basement_carpet_b_off_time"),
  "basement flooring off time": (submission) => getResponseValue(submission, "basement_flooring_off_time"),
  "basement marketing off time": (submission) => getResponseValue(submission, "basement_marketing_off_time"),
  "basement backside a off time": (submission) => getResponseValue(submission, "basement_backside_a_off_time"),
  "basement backside b off time": (submission) => getResponseValue(submission, "basement_backside_b_off_time"),
  "vishal sir cabin off time": (submission) => getResponseValue(submission, "vishal_sir_cabin_off_time"),
  "mdo cabin": (submission) => getResponseValue(submission, "mdo_cabin"),
  "sweta maam cabin new": (submission) => getResponseValue(submission, "sweta_maam_cabin_new"),
  "crm cabin": (submission) => getResponseValue(submission, "crm_cabin"),
  "divij sir cabin": (submission) => getResponseValue(submission, "divij_sir_cabin"),
  "ground bar area off time": (submission) => getResponseValue(submission, "ground_bar_area_off_time"),
  "conference room sweta maam": (submission) => getResponseValue(submission, "conference_room_sweta_maam"),
  "1st floor hr room off time": (submission) => getResponseValue(submission, "first_floor_hr_room_off_time"),
  "2nd floor accounts room off time": (submission) => getResponseValue(submission, "second_floor_accounts_room_off_time"),
  "1st floor pantry a off time": (submission) => getResponseValue(submission, "first_floor_pantry_a_off_time"),
  "1st floor pantry b off time": (submission) => getResponseValue(submission, "first_floor_pantry_b_off_time"),
  "1st floor marketing a off time": (submission) => getResponseValue(submission, "first_floor_marketing_a_off_time"),
  "1st floor marketing b off time": (submission) => getResponseValue(submission, "first_floor_marketing_b_off_time"),
  "2nd floor server room off time": (submission) => getResponseValue(submission, "second_floor_server_room_off_time"),
  "ground reception area off time": (submission) => getResponseValue(submission, "ground_reception_area_off_time"),
};

function base64url(input) {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function normalizeTaskTitle(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeHeader(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/['’()]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function formatSheetTimestamp(value) {
  const date = value ? new Date(value) : new Date();
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: INDIA_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${byType.day}/${byType.month}/${byType.year} ${byType.hour}:${byType.minute}:${byType.second}`;
}

function formatSheetDate(value) {
  if (!value) {
    return "";
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(String(value))) {
    const [year, month, day] = String(value).split("-");
    return `${day}/${month}/${year}`;
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "";
  }

  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: INDIA_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${byType.day}/${byType.month}/${byType.year}`;
}

function getResponseValue(submission, key) {
  const value = submission.responses && Object.prototype.hasOwnProperty.call(submission.responses, key)
    ? submission.responses[key]
    : "";
  return value == null ? "" : String(value);
}

function loadSheetExportConfig(rootDir) {
  const configPath = path.join(rootDir, CHECKLIST_SHEET_CONFIG_PATH);
  if (!fs.existsSync(configPath)) {
    return null;
  }

  return JSON.parse(fs.readFileSync(configPath, "utf8"));
}

function loadChecklistSheetConfig(rootDir) {
  const parsed = loadSheetExportConfig(rootDir);
  return parsed && parsed.acChecklist ? parsed.acChecklist : null;
}

function loadUsersSheetConfig(rootDir) {
  const parsed = loadSheetExportConfig(rootDir);
  if (!parsed) {
    return null;
  }

  if (parsed.usersSheet && parsed.usersSheet.spreadsheetId) {
    return parsed.usersSheet;
  }

  if (parsed.acChecklist && parsed.acChecklist.spreadsheetId) {
    return {
      spreadsheetId: parsed.acChecklist.spreadsheetId,
      sheetTitle: DEFAULT_USERS_SHEET_TITLE,
    };
  }

  return null;
}

function loadServiceAccount(rootDir) {
  const keyPath = path.join(rootDir, SERVICE_ACCOUNT_FILENAME);
  if (!fs.existsSync(keyPath)) {
    throw new Error(`Google service account key not found at ${keyPath}.`);
  }
  return JSON.parse(fs.readFileSync(keyPath, "utf8"));
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
    throw new Error(`Could not get Google Sheets access token: ${JSON.stringify(data)}`);
  }
  return data.access_token;
}

async function getSpreadsheetMeta(token, spreadsheetId) {
  const response = await fetch(`${SHEETS_API_BASE}/${spreadsheetId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(`Could not read spreadsheet metadata: ${JSON.stringify(data)}`);
  }
  return data;
}

async function ensureSheetTabExists(token, spreadsheetId, existingTitles, sheetTitle) {
  if (existingTitles.includes(sheetTitle)) {
    return;
  }

  const response = await fetch(`${SHEETS_API_BASE}/${spreadsheetId}:batchUpdate`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      requests: [{ addSheet: { properties: { title: sheetTitle } } }],
    }),
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(`Could not create sheet tab "${sheetTitle}": ${JSON.stringify(data)}`);
  }
}

function resolveSheetTitle(meta, config) {
  if (config.sheetTitle) {
    return config.sheetTitle;
  }

  const numericSheetId = Number(config.sheetId);
  const matchedSheet = (meta.sheets || []).find(
    (sheet) => Number(sheet.properties && sheet.properties.sheetId) === numericSheetId
  );
  if (!matchedSheet) {
    throw new Error(`Could not find sheet tab for sheetId ${config.sheetId}.`);
  }
  return matchedSheet.properties.title;
}

async function getHeaderRow(token, spreadsheetId, sheetTitle) {
  const encodedRange = encodeURIComponent(`'${sheetTitle}'!1:1`);
  const response = await fetch(`${SHEETS_API_BASE}/${spreadsheetId}/values/${encodedRange}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(`Could not read header row from "${sheetTitle}": ${JSON.stringify(data)}`);
  }
  return Array.isArray(data.values) && Array.isArray(data.values[0]) ? data.values[0] : [];
}

function buildRowFromHeaders(headers, submission) {
  return headers.map((header) => {
    const resolver = HEADER_VALUE_RESOLVERS[normalizeHeader(header)];
    return resolver ? resolver(submission) : "";
  });
}

async function appendRow(token, spreadsheetId, sheetTitle, row) {
  const encodedRange = encodeURIComponent(`'${sheetTitle}'`);
  const response = await fetch(
    `${SHEETS_API_BASE}/${spreadsheetId}/values/${encodedRange}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ values: [row] }),
    }
  );
  const data = await response.json();
  if (!response.ok) {
    throw new Error(`Could not append checklist submission to "${sheetTitle}": ${JSON.stringify(data)}`);
  }
  return data;
}

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

async function writeTab(token, spreadsheetId, title, rows) {
  const range = encodeURIComponent(`'${title}'`);

  await fetch(`${SHEETS_API_BASE}/${spreadsheetId}/values/${range}:clear`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });

  const response = await fetch(
    `${SHEETS_API_BASE}/${spreadsheetId}/values/${range}!A1?valueInputOption=RAW`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ values: rows }),
    }
  );
  const data = await response.json();
  if (!response.ok) {
    throw new Error(`Could not write to the "${title}" tab: ${JSON.stringify(data)}`);
  }
  return data;
}

async function appendChecklistSubmission(rootDir, submission) {
  if (normalizeTaskTitle(submission && submission.taskTitle) !== EXPORT_TASK_TITLE) {
    return { skipped: true, reason: "unsupported_task" };
  }

  const config = loadChecklistSheetConfig(rootDir);
  if (!config || !config.spreadsheetId || (!config.sheetTitle && config.sheetId == null)) {
    return { skipped: true, reason: "missing_config" };
  }

  const serviceAccount = loadServiceAccount(rootDir);
  const token = await getAccessToken(serviceAccount);
  const meta = await getSpreadsheetMeta(token, config.spreadsheetId);
  const sheetTitle = resolveSheetTitle(meta, config);
  const headers = await getHeaderRow(token, config.spreadsheetId, sheetTitle);
  if (!headers.length) {
    throw new Error(`The "${sheetTitle}" tab has no header row to map checklist values into.`);
  }

  const row = buildRowFromHeaders(headers, submission);
  await appendRow(token, config.spreadsheetId, sheetTitle, row);
  return { skipped: false, spreadsheetId: config.spreadsheetId, sheetTitle };
}

async function syncUsersSheet(rootDir, users) {
  const config = loadUsersSheetConfig(rootDir);
  if (!config || !config.spreadsheetId) {
    return { skipped: true, reason: "missing_config" };
  }

  const sheetTitle = config.sheetTitle || DEFAULT_USERS_SHEET_TITLE;
  const serviceAccount = loadServiceAccount(rootDir);
  const token = await getAccessToken(serviceAccount);
  const meta = await getSpreadsheetMeta(token, config.spreadsheetId);
  const existingTitles = (meta.sheets || []).map((sheet) => sheet.properties.title);
  await ensureSheetTabExists(token, config.spreadsheetId, existingTitles, sheetTitle);

  const safeUsers = (Array.isArray(users) ? users : []).map((user) => {
    const { password, ...rest } = user || {};
    return rest;
  });
  const rows = safeUsers.length
    ? objectsToRows(safeUsers)
    : [["name", "email", "role", "designation", "code", "dayOff"]];

  await writeTab(token, config.spreadsheetId, sheetTitle, rows);
  return {
    skipped: false,
    spreadsheetId: config.spreadsheetId,
    sheetTitle,
    rowCount: Math.max(rows.length - 1, 0),
  };
}

module.exports = {
  appendChecklistSubmission,
  syncUsersSheet,
};
