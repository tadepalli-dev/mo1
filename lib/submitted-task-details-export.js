const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const CHECKLIST_SHEET_CONFIG_PATH = "checklist-sheet-config.json";
const SERVICE_ACCOUNT_FILENAME = "service-account-key.json";
const SHEETS_API_SCOPE = "https://www.googleapis.com/auth/spreadsheets";
const SHEETS_API_BASE = "https://sheets.googleapis.com/v4/spreadsheets";
const DEFAULT_SHEET_TITLE = "Submitted Task Details";
const INDIA_TIME_ZONE = "Asia/Calcutta";
const EXPORT_START_DATE = "2026-07-22";
const HEADERS = [
  "Completion Key",
  "Record Type",
  "Detail Scope",
  "Occurrence Date",
  "Submitted At",
  "Employee Name",
  "Employee Email",
  "Role",
  "Designation",
  "Department",
  "Task",
  "Task ID",
  "Occurrence Slot",
  "Customer Name",
  "Walk-in ID",
  "Status",
  "Approval Status",
  "Review Stage",
  "Attachment Files",
  "Attachment URLs",
  "Photo Files",
  "Photo URLs",
  "Screenshot Files",
  "Screenshot URLs",
  "Meter Reading",
  "Odometer Reading",
  "Fuel Quantity",
  "Fuel Cost Amount",
  "KVAH Reading",
  "KVAH Photo Files",
  "KVAH Photo URLs",
  "KWAH Reading",
  "KWAH Photo Files",
  "KWAH Photo URLs",
  "Cash Total Amount",
  "Cash Coins Amount",
  "Cash Denominations",
  "Cash Coins",
  "Task Details",
  "Entered Details",
  "Remarks",
  "Raw Responses JSON",
];

function base64url(input) {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function normalizeValue(value) {
  return value == null ? "" : String(value);
}

function normalizePersonName(value) {
  return normalizeValue(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function humanizeKey(key) {
  return normalizeValue(key)
    .replace(/_/g, " ")
    .replace(/\b\w/g, (match) => match.toUpperCase());
}

function hasDisplayValue(value) {
  if (value == null) {
    return false;
  }
  if (typeof value === "string") {
    return value.trim() !== "";
  }
  if (Array.isArray(value)) {
    return value.some((item) => hasDisplayValue(item));
  }
  if (typeof value === "object") {
    return Object.values(value).some((item) => hasDisplayValue(item));
  }
  return true;
}

function formatPrimitive(value) {
  if (typeof value === "boolean") {
    return value ? "Yes" : "No";
  }
  return normalizeValue(value);
}

function flattenValue(value) {
  if (!hasDisplayValue(value)) {
    return "";
  }

  if (Array.isArray(value)) {
    return value
      .map((item) => {
        if (item && typeof item === "object") {
          return Object.entries(item)
            .filter(([, nestedValue]) => hasDisplayValue(nestedValue))
            .map(([key, nestedValue]) => `${humanizeKey(key)}: ${flattenValue(nestedValue)}`)
            .join(", ");
        }
        return formatPrimitive(item);
      })
      .filter(Boolean)
      .join(" | ");
  }

  if (typeof value === "object") {
    return Object.entries(value)
      .filter(([, nestedValue]) => hasDisplayValue(nestedValue))
      .map(([key, nestedValue]) => `${humanizeKey(key)}: ${flattenValue(nestedValue)}`)
      .join(" | ");
  }

  return formatPrimitive(value);
}

function flattenResponses(responses) {
  return Object.entries(responses || {})
    .filter(([, value]) => hasDisplayValue(value))
    .map(([key, value]) => `${humanizeKey(key)}: ${flattenValue(value)}`)
    .join(" || ");
}

function isChildCompletionRecord(completionKey) {
  const key = normalizeValue(completionKey);
  return (
    key.includes("__visit") ||
    key.includes("__generator__") ||
    key.includes("__cashshift__") ||
    key.includes("__meterlocation__") ||
    key.includes("__earthinglocation__")
  );
}

function getRecordType(completionKey) {
  const key = normalizeValue(completionKey);
  if (key.includes("__visit")) {
    return "Site Visit Detail";
  }
  if (key.includes("__generator__")) {
    return "Generator Detail";
  }
  if (key.includes("__cashshift__")) {
    return "Cash Shift Detail";
  }
  if (key.includes("__meterlocation__")) {
    return "Meter Location Detail";
  }
  if (key.includes("__earthinglocation__")) {
    return "Earthing Location Detail";
  }
  if (key.includes("__cust_")) {
    return "Customer Task Submission";
  }
  return "Checklist Submission";
}

function getDetailScope(completion) {
  if (completion?.visitNumber) {
    return `Visit ${completion.visitNumber}`;
  }
  if (completion?.generatorUnit) {
    return completion.generatorUnit;
  }
  if (completion?.shift) {
    return completion.shift;
  }
  if (completion?.location) {
    return completion.location;
  }
  if (completion?.occurrenceSlotLabel) {
    return completion.occurrenceSlotLabel;
  }
  if (completion?.occurrenceSlot) {
    return completion.occurrenceSlot;
  }
  return "";
}

function getTaskCustomerName(task) {
  return task?.customerAttributionName || task?.customerName || "";
}

function getTaskCustomerKey(task) {
  return task?.customerAttributionKey || task?.walkinId || "";
}

function formatOccurrenceDate(value) {
  if (!value) {
    return "";
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(value))) {
    return String(value);
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}

function formatTimestamp(value) {
  if (!value) {
    return "";
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
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${byType.year}-${byType.month}-${byType.day} ${byType.hour}:${byType.minute}:${byType.second}`;
}

function getTaskDisplayTitle(task, completion) {
  const title = task?.title || "Checklist submission";
  const slotLabel = completion?.occurrenceSlotLabel || task?.occurrenceSlotLabel || "";
  return slotLabel ? `${title} (${slotLabel})` : title;
}

function collectAttachmentFiles(value, key = "", bucket = { all: [], photos: [], screenshots: [], items: [] }) {
  if (value && typeof value === "object" && !Array.isArray(value) && value.pathname && value.name) {
    bucket.items.push({ name: String(value.name), pathname: String(value.pathname), key });
  }

  if (Array.isArray(value)) {
    const attachmentItems = value
      .map((item) => (typeof item === "string" ? item : item?.name || ""))
      .filter(Boolean);
    if (attachmentItems.length) {
      bucket.all.push(...attachmentItems);
      const normalizedKey = key.toLowerCase();
      if (normalizedKey.includes("photo")) {
        bucket.photos.push(...attachmentItems);
      }
      if (normalizedKey.includes("screenshot")) {
        bucket.screenshots.push(...attachmentItems);
      }
    }

    value.forEach((item) => {
      if (item && typeof item === "object") {
        collectAttachmentFiles(item, key, bucket);
      }
    });
    return bucket;
  }

  if (value && typeof value === "object") {
    Object.entries(value).forEach(([nestedKey, nestedValue]) => {
      collectAttachmentFiles(nestedValue, nestedKey, bucket);
    });
  }

  return bucket;
}

function joinUnique(items) {
  return [...new Set((items || []).filter(Boolean))].join(", ");
}

function attachmentUrls(items, attachmentUrlBuilder) {
  if (typeof attachmentUrlBuilder !== "function") {
    return "";
  }
  return joinUnique((items || []).map((item) => attachmentUrlBuilder(item.pathname)).filter(Boolean));
}

function attachmentUrlsForResponse(responses, key, attachmentUrlBuilder) {
  const bucket = collectAttachmentFiles(responses?.[key], key);
  return attachmentUrls(bucket.items, attachmentUrlBuilder);
}

function stringifyObject(value) {
  if (value == null) {
    return "";
  }
  return JSON.stringify(value);
}

function getScalarResponse(responses, key) {
  const value = responses?.[key];
  if (value == null) {
    return "";
  }
  if (Array.isArray(value) || typeof value === "object") {
    return flattenValue(value);
  }
  return normalizeValue(value);
}

function getPendingReviewStages(completion) {
  const stages = [];
  if (completion?.hrApprovalStatus === "pending") {
    stages.push("HR approval");
  }
  if (completion?.kamalApprovalStatus === "pending") {
    stages.push("Kamal approval");
  }
  if (completion?.cashierApprovalStatus === "pending") {
    stages.push("Cashier approval");
  }
  if (completion?.arunApprovalStatus === "pending") {
    stages.push("Arun approval");
  }
  if (completion?.fuelRequestApprovalStatus === "pending") {
    stages.push("Fuel approval");
  }
  return stages;
}

function getReviewStage(completion) {
  if (completion?.approvalStatus === "approved") {
    return completion.approvedByName ? `Approved by ${completion.approvedByName}` : "Approved";
  }
  const stages = getPendingReviewStages(completion);
  return stages.length ? `Waiting for ${stages.join(", ")}` : "Pending final review";
}

function getStatusLabel(completion) {
  return completion?.status === "not_completed" ? "Not completed" : "Submitted";
}

function findUserForCompletion(task, completion, users) {
  const safeUsers = Array.isArray(users) ? users : [];
  const targetEmail = normalizeValue(completion?.submittedByEmail || task?.assigneeEmail).toLowerCase();
  if (targetEmail) {
    const matchedByEmail = safeUsers.find((user) => normalizeValue(user?.email).toLowerCase() === targetEmail);
    if (matchedByEmail) {
      return matchedByEmail;
    }
  }

  const targetName = normalizePersonName(completion?.submittedByName || task?.assigneeName);
  if (!targetName) {
    return null;
  }
  return safeUsers.find((user) => normalizePersonName(user?.name) === targetName) || null;
}

function loadSheetExportConfig(rootDir) {
  const configPath = path.join(rootDir, CHECKLIST_SHEET_CONFIG_PATH);
  if (!fs.existsSync(configPath)) {
    return null;
  }
  return JSON.parse(fs.readFileSync(configPath, "utf8"));
}

function loadSubmittedDetailsSheetConfig(rootDir) {
  const parsed = loadSheetExportConfig(rootDir);
  if (!parsed) {
    return null;
  }

  if (parsed.submissionDetailsSheet?.spreadsheetId) {
    return parsed.submissionDetailsSheet;
  }

  if (parsed.acChecklist?.spreadsheetId) {
    return {
      spreadsheetId: parsed.acChecklist.spreadsheetId,
      sheetTitle: DEFAULT_SHEET_TITLE,
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

function buildSubmittedTaskDetailsRows(tasks, completions, users, { attachmentUrlBuilder } = {}) {
  const safeTasks = Array.isArray(tasks) ? tasks : [];
  const safeUsers = Array.isArray(users) ? users : [];
  const safeCompletions = completions && typeof completions === "object" ? completions : {};

  const rows = Object.entries(safeCompletions)
    .map(([completionKey, completion]) => {
      const task = safeTasks.find((item) => String(item.taskId || item.id) === String(completion.taskId)) || null;
      const user = findUserForCompletion(task, completion, safeUsers);
      const responses = completion.responses || {};
      const attachments = collectAttachmentFiles(responses);
      const recordType = getRecordType(completionKey);
      const detailScope = getDetailScope(completion);

      return [
        completionKey,
        recordType,
        detailScope,
        formatOccurrenceDate(completion.occurrenceDate || completion.submittedAt),
        formatTimestamp(completion.submittedAt),
        completion.submittedByName || task?.assigneeName || user?.name || "",
        completion.submittedByEmail || task?.assigneeEmail || user?.email || "",
        user?.role || "",
        user?.designation || "",
        task?.department || "",
        getTaskDisplayTitle(task, completion),
        task?.taskId || task?.id || completion.taskId || "",
        completion.occurrenceSlotLabel || completion.occurrenceSlot || "",
        getTaskCustomerName(task),
        getTaskCustomerKey(task),
        getStatusLabel(completion),
        completion.approvalStatus || "pending",
        getReviewStage(completion),
        joinUnique(attachments.all),
        attachmentUrls(attachments.items, attachmentUrlBuilder),
        joinUnique(attachments.photos),
        attachmentUrls(attachments.items.filter((item) => item.key.toLowerCase().includes("photo")), attachmentUrlBuilder),
        joinUnique(attachments.screenshots),
        attachmentUrls(attachments.items.filter((item) => item.key.toLowerCase().includes("screenshot")), attachmentUrlBuilder),
        getScalarResponse(responses, "meter_reading"),
        getScalarResponse(responses, "odometer_reading"),
        getScalarResponse(responses, "fuel_amount"),
        getScalarResponse(responses, "fuel_cost_amount"),
        getScalarResponse(responses, "kvah_meter_reading"),
        getScalarResponse(responses, "kvah_meter_photo"),
        attachmentUrlsForResponse(responses, "kvah_meter_photo", attachmentUrlBuilder),
        getScalarResponse(responses, "kwah_meter_reading"),
        getScalarResponse(responses, "kwah_meter_photo"),
        attachmentUrlsForResponse(responses, "kwah_meter_photo", attachmentUrlBuilder),
        getScalarResponse(responses, "total_cash_amount"),
        getScalarResponse(responses, "coins_amount"),
        stringifyObject(responses?.denominations || ""),
        stringifyObject(responses?.coins || ""),
        task?.details || "",
        flattenResponses(responses),
        completion.remarks || "",
        JSON.stringify(responses),
      ];
    })
    .filter((row) => row[3] >= EXPORT_START_DATE)
    .sort((left, right) => {
      if (left[1] !== right[1]) {
        return left[1] < right[1] ? 1 : -1;
      }
      if (left[2] !== right[2]) {
        return left[2] < right[2] ? 1 : -1;
      }
      return normalizeValue(left[3]).localeCompare(normalizeValue(right[3]));
    });

  return [HEADERS, ...rows];
}

async function rewriteSubmittedTaskDetailsSheet(rootDir, { tasks, completions, users }, options = {}) {
  const config = loadSubmittedDetailsSheetConfig(rootDir);
  if (!config?.spreadsheetId) {
    return { skipped: true, reason: "missing_config" };
  }

  const sheetTitle = config.sheetTitle || DEFAULT_SHEET_TITLE;
  const serviceAccount = loadServiceAccount(rootDir);
  const token = await getAccessToken(serviceAccount);
  const meta = await getSpreadsheetMeta(token, config.spreadsheetId);
  const existingTitles = (meta.sheets || []).map((sheet) => sheet.properties.title);
  await ensureSheetTabExists(token, config.spreadsheetId, existingTitles, sheetTitle);

  const rows = buildSubmittedTaskDetailsRows(tasks, completions, users, options);
  await writeTab(token, config.spreadsheetId, sheetTitle, rows.length ? rows : [HEADERS]);

  return {
    ok: true,
    skipped: false,
    spreadsheetId: config.spreadsheetId,
    sheetTitle,
    spreadsheetUrl: `https://docs.google.com/spreadsheets/d/${config.spreadsheetId}/edit`,
    rowCount: Math.max(rows.length - 1, 0),
  };
}

module.exports = {
  rewriteSubmittedTaskDetailsSheet,
  buildSubmittedTaskDetailsRows,
};
