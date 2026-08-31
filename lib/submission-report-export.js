const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const SERVICE_ACCOUNT_FILENAME = "service-account-key.json";
const REPORT_SOURCE_FILENAME = "submission-report-source.json";
const SHEETS_API_BASE = "https://sheets.googleapis.com/v4/spreadsheets";
const REPORT_CONFIG_FILENAME = "submission-report-config.json";
const SHEET_TITLE = "Sheet1";
const LATE_PENALTY_PER_DAY = 10;
const HEADERS = [
  "Date",
  "Name",
  "Email",
  "Role",
  "Designation",
  "Department",
  "Task",
  "Task ID",
  "Customer Name",
  "Walk-in ID",
  "Record Type",
  "Detail Scope",
  "Actual Date",
  "Timestamp",
  "Status",
  "Approval Status",
  "Review Stage",
  "Uploaded Files",
  "Photo Files",
  "Screenshot Files",
  "PDF Files",
  "Meter Reading",
  "Odometer Reading",
  "Fuel Quantity",
  "Fuel Cost Amount",
  "KVAH Reading",
  "KVAH Photo Files",
  "KWAH Reading",
  "KWAH Photo Files",
  "Cash Total Amount",
  "Cash Coins Amount",
  "Cash Denominations",
  "Cash Coins",
  "Task Details",
  "Entered Details",
  "Remarks",
  "Raw Responses JSON",
  "Score",
];

function base64url(input) {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function loadServiceAccount(rootDir) {
  const keyPath = path.join(rootDir, SERVICE_ACCOUNT_FILENAME);
  if (!fs.existsSync(keyPath)) {
    throw new Error("service-account-key.json is missing");
  }
  return JSON.parse(fs.readFileSync(keyPath, "utf8"));
}

async function getAccessToken(serviceAccount, scope) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const claims = {
    iss: serviceAccount.client_email,
    scope,
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
    throw new Error(`Could not get Google access token: ${JSON.stringify(data)}`);
  }
  return data.access_token;
}

function getReportConfigPath(rootDir) {
  return path.join(rootDir, "data", REPORT_CONFIG_FILENAME);
}

function loadReportConfig(rootDir) {
  const configPath = getReportConfigPath(rootDir);
  if (!fs.existsSync(configPath)) {
    return null;
  }
  return JSON.parse(fs.readFileSync(configPath, "utf8"));
}

function saveReportConfig(rootDir, config) {
  fs.writeFileSync(getReportConfigPath(rootDir), JSON.stringify(config, null, 2), "utf8");
}

function loadHostSpreadsheetId(rootDir) {
  const configPath = path.join(rootDir, REPORT_SOURCE_FILENAME);
  if (!fs.existsSync(configPath)) {
    throw new Error(
      `${REPORT_SOURCE_FILENAME} is missing — create a Google Sheet, share it with the service account as Editor, then save its spreadsheetId into ${REPORT_SOURCE_FILENAME}.`
    );
  }
  const parsed = JSON.parse(fs.readFileSync(configPath, "utf8"));
  if (!parsed?.spreadsheetId) {
    throw new Error(`${REPORT_SOURCE_FILENAME} has no spreadsheetId.`);
  }
  return parsed.spreadsheetId;
}

async function createReportSheetTab(rootDir, serviceAccount) {
  const spreadsheetId = loadHostSpreadsheetId(rootDir);
  const token = await getAccessToken(serviceAccount, "https://www.googleapis.com/auth/spreadsheets");

  const metaResponse = await fetch(`${SHEETS_API_BASE}/${spreadsheetId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const meta = await metaResponse.json();
  if (!metaResponse.ok) {
    throw new Error(meta?.error?.message || `Could not read spreadsheet ${spreadsheetId}.`);
  }

  let sheetMeta = (meta.sheets || []).find((sheet) => sheet.properties?.title === SHEET_TITLE);

  if (!sheetMeta) {
    const addResponse = await fetch(`${SHEETS_API_BASE}/${spreadsheetId}:batchUpdate`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ requests: [{ addSheet: { properties: { title: SHEET_TITLE } } }] }),
    });
    const added = await addResponse.json();
    if (!addResponse.ok) {
      throw new Error(added?.error?.message || `Could not add the "${SHEET_TITLE}" tab.`);
    }
    sheetMeta = added.replies[0].addSheet;
  }

  await fetch(`${SHEETS_API_BASE}/${spreadsheetId}/values/${encodeURIComponent(`'${SHEET_TITLE}'!A1`)}:append?valueInputOption=RAW`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ values: [HEADERS] }),
  });

  const config = {
    spreadsheetId,
    sheetTitle: SHEET_TITLE,
    sheetId: sheetMeta.properties.sheetId,
    url: `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit#gid=${sheetMeta.properties.sheetId}`,
  };
  saveReportConfig(rootDir, config);
  return config;
}

async function ensureSubmissionReportSheet(rootDir) {
  const existing = loadReportConfig(rootDir);
  if (existing) {
    return existing;
  }
  const serviceAccount = loadServiceAccount(rootDir);
  return createReportSheetTab(rootDir, serviceAccount);
}

function formatDatePart(value) {
  if (!value) {
    return "-";
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(value))) {
    const [year, month, day] = String(value).split("-");
    return `${day}/${month}/${year}`;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "-";
  }
  const day = String(date.getDate()).padStart(2, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  return `${day}/${month}/${date.getFullYear()}`;
}

function formatTimestamp(value) {
  if (!value) {
    return "-";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "-";
  }
  const day = String(date.getDate()).padStart(2, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  const seconds = String(date.getSeconds()).padStart(2, "0");
  return `${day}/${month}/${date.getFullYear()} ${hours}:${minutes}:${seconds}`;
}

// Score: 100 if submitted on or before the planned date, minus
// LATE_PENALTY_PER_DAY for every day late, floored at 0. "-" if not
// submitted yet — there's nothing to score until it's actually done.
function calculateScore(plannedDate, submittedAt) {
  if (!plannedDate || !submittedAt) {
    return "-";
  }
  const planned = new Date(`${plannedDate}T00:00:00`);
  const actual = new Date(submittedAt);
  if (Number.isNaN(planned.getTime()) || Number.isNaN(actual.getTime())) {
    return "-";
  }
  const actualDateOnly = new Date(actual.getFullYear(), actual.getMonth(), actual.getDate());
  const daysLate = Math.round((actualDateOnly.getTime() - planned.getTime()) / 86400000);
  if (daysLate <= 0) {
    return 100;
  }
  return Math.max(0, 100 - daysLate * LATE_PENALTY_PER_DAY);
}

function buildRow(entry) {
  return [
    formatDatePart(entry.plannedDate),
    entry.assigneeName || "",
    entry.assigneeEmail || "",
    entry.role || "",
    entry.designation || "",
    entry.department || "",
    entry.taskTitle || "",
    entry.taskId || "",
    entry.customerName || "",
    entry.walkinId || "",
    entry.recordType || "",
    entry.detailScope || "",
    formatDatePart(entry.submittedAt),
    formatTimestamp(entry.submittedAt),
    entry.status || "",
    entry.approvalStatus || "",
    entry.reviewStage || "",
    entry.uploadedFiles || "",
    entry.photoFiles || "",
    entry.screenshotFiles || "",
    entry.pdfFiles || "",
    entry.meterReading || "",
    entry.odometerReading || "",
    entry.fuelQuantity || "",
    entry.fuelCostAmount || "",
    entry.kvahReading || "",
    entry.kvahPhotoFiles || "",
    entry.kwahReading || "",
    entry.kwahPhotoFiles || "",
    entry.cashTotalAmount || "",
    entry.cashCoinsAmount || "",
    entry.cashDenominations || "",
    entry.cashCoins || "",
    entry.taskDetails || "",
    entry.enteredDetails || "",
    entry.remarks || "",
    entry.rawResponsesJson || "",
    calculateScore(entry.plannedDate, entry.submittedAt),
  ];
}

async function rewriteSubmissionReport(rootDir, entries) {
  const config = await ensureSubmissionReportSheet(rootDir);
  const serviceAccount = loadServiceAccount(rootDir);
  const token = await getAccessToken(serviceAccount, "https://www.googleapis.com/auth/spreadsheets");

  const encodedRange = encodeURIComponent(`'${config.sheetTitle}'`);
  await fetch(`${SHEETS_API_BASE}/${config.spreadsheetId}/values/${encodedRange}:clear`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });

  const rows = [HEADERS, ...entries.map(buildRow)];
  const response = await fetch(
    `${SHEETS_API_BASE}/${config.spreadsheetId}/values/${encodedRange}!A1?valueInputOption=RAW`,
    {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ values: rows }),
    }
  );
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data?.error?.message || "Could not write the submission report.");
  }

  return { ok: true, spreadsheetUrl: config.url, rowCount: entries.length };
}

module.exports = {
  ensureSubmissionReportSheet,
  rewriteSubmissionReport,
};
