// Appends every client-form submission (the "Client Style & Requirements"
// intake form opened from the "Take input of customer requirement" task) as
// its own row in a dedicated tab, in the same spreadsheet already used for
// the general submission report (submission-report-source.json) — so
// management has one place to look, on a separate tab from the generic
// per-task audit rows.
//
// Unlike the generic submission report (which clears and rewrites its tab
// from scratch every sync), this only ever appends — each real submission
// becomes exactly one new row, and nothing already written is ever touched
// again.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const SERVICE_ACCOUNT_FILENAME = "service-account-key.json";
const REPORT_SOURCE_FILENAME = "submission-report-source.json";
const SHEETS_API_BASE = "https://sheets.googleapis.com/v4/spreadsheets";
const SHEET_TITLE = "Client Form Submissions";

const HEADERS = [
  "Timestamp",
  "Submitted By",
  "Submitted By Email",
  "Customer Name",
  "Deal ID (Walk-in ID)",
  "Full Name",
  "Phone",
  "Location",
  "Home Stage",
  "Rooms",
  "Living Room Products",
  "Bedroom Products",
  "Bathroom Products",
  "Dining Products",
  "Office Products",
  "Specific Items",
  "Specific Item Details",
  "Design Styles",
  "Color Palette",
  "Decorative Level",
  "Curtain Style",
  "Curtain Heading",
  "Curtain Fabric",
  "Linen Feel",
  "Linen Pattern",
  "Accent Details",
  "Priorities",
  "Budget",
  "Inspiration",
  "Dislikes",
  "Three Words",
];

function base64url(input) {
  return Buffer.from(input).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function loadServiceAccount(rootDir) {
  const keyPath = path.join(rootDir, SERVICE_ACCOUNT_FILENAME);
  if (!fs.existsSync(keyPath)) {
    throw new Error("service-account-key.json is missing");
  }
  return JSON.parse(fs.readFileSync(keyPath, "utf8"));
}

async function getAccessToken(serviceAccount) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const claims = {
    iss: serviceAccount.client_email,
    scope: "https://www.googleapis.com/auth/spreadsheets",
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
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: jwt }),
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(`Could not get Google access token: ${JSON.stringify(data)}`);
  }
  return data.access_token;
}

function loadHostSpreadsheetId(rootDir) {
  const configPath = path.join(rootDir, REPORT_SOURCE_FILENAME);
  if (!fs.existsSync(configPath)) {
    throw new Error(`${REPORT_SOURCE_FILENAME} is missing.`);
  }
  const parsed = JSON.parse(fs.readFileSync(configPath, "utf8"));
  if (!parsed?.spreadsheetId) {
    throw new Error(`${REPORT_SOURCE_FILENAME} has no spreadsheetId.`);
  }
  return parsed.spreadsheetId;
}

async function ensureSheetTabWithHeader(token, spreadsheetId) {
  const metaResponse = await fetch(`${SHEETS_API_BASE}/${spreadsheetId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const meta = await metaResponse.json();
  if (!metaResponse.ok) {
    throw new Error(meta?.error?.message || `Could not read spreadsheet ${spreadsheetId}.`);
  }

  const exists = (meta.sheets || []).some((sheet) => sheet.properties?.title === SHEET_TITLE);
  if (!exists) {
    const addResponse = await fetch(`${SHEETS_API_BASE}/${spreadsheetId}:batchUpdate`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ requests: [{ addSheet: { properties: { title: SHEET_TITLE } } }] }),
    });
    const added = await addResponse.json();
    if (!addResponse.ok) {
      throw new Error(added?.error?.message || `Could not create the "${SHEET_TITLE}" tab.`);
    }

    await fetch(
      `${SHEETS_API_BASE}/${spreadsheetId}/values/${encodeURIComponent(`'${SHEET_TITLE}'!A1`)}?valueInputOption=RAW`,
      {
        method: "PUT",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ values: [HEADERS] }),
      }
    );
  }
}

function joinList(value) {
  return Array.isArray(value) ? value.join(", ") : "";
}

function formatTimestamp(value) {
  const date = value ? new Date(value) : new Date();
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  const day = String(date.getDate()).padStart(2, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  const seconds = String(date.getSeconds()).padStart(2, "0");
  return `${day}/${month}/${date.getFullYear()} ${hours}:${minutes}:${seconds}`;
}

function buildRow(submission) {
  return [
    formatTimestamp(submission.submittedAt),
    submission.submittedByName || "",
    submission.submittedByEmail || "",
    submission.customerName || "",
    submission.walkinId || "",
    submission.fullName || "",
    submission.phone || "",
    submission.location || "",
    submission.homeStage || "",
    joinList(submission.rooms),
    joinList(submission.livingRoomProducts),
    joinList(submission.bedroomProducts),
    joinList(submission.bathroomProducts),
    joinList(submission.diningProducts),
    joinList(submission.officeProducts),
    joinList(submission.specificItems),
    submission.specificItemDetails || submission.specificItem || "",
    joinList(submission.designStyles),
    submission.colorPalette || "",
    submission.decorativeLevel || "",
    submission.curtainStyle || "",
    submission.curtainHeading || "",
    submission.curtainFabric || "",
    submission.linenFeel || "",
    submission.linenPattern || "",
    joinList(submission.accentDetails),
    joinList(submission.priorities),
    submission.budget || "",
    joinList(submission.inspiration),
    submission.dislikes || "",
    submission.threeWords || "",
  ];
}

async function appendClientFormSubmissionRow(rootDir, submission) {
  const spreadsheetId = loadHostSpreadsheetId(rootDir);
  const serviceAccount = loadServiceAccount(rootDir);
  const token = await getAccessToken(serviceAccount);

  await ensureSheetTabWithHeader(token, spreadsheetId);

  const row = buildRow(submission);
  // RAW, not USER_ENTERED — the timestamp string ("DD/MM/YYYY HH:mm:ss")
  // otherwise gets silently reinterpreted as a date and can display as a
  // bare serial number (e.g. "46263.63") instead of readable text,
  // depending on the sheet's locale/column formatting.
  const response = await fetch(
    `${SHEETS_API_BASE}/${spreadsheetId}/values/${encodeURIComponent(`'${SHEET_TITLE}'`)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ values: [row] }),
    }
  );
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data?.error?.message || "Could not append the client form submission row.");
  }

  return { ok: true, spreadsheetId, sheetTitle: SHEET_TITLE };
}

module.exports = { appendClientFormSubmissionRow };
