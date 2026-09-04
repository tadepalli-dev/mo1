
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const SERVICE_ACCOUNT_FILENAME = "service-account-key.json";
const SHEETS_API_SCOPE = "https://www.googleapis.com/auth/spreadsheets.readonly";
const SHEETS_API_BASE = "https://sheets.googleapis.com/v4/spreadsheets";

const VEHICLE_SHEETS = Object.freeze([
  {
    label: "Four Wheeler",
    vehicleType: "Four Wheeler",
    spreadsheetId: "1dbZTh1o_g1v2hSFY59wYZJ28gf8c-rI98qLHUU-Pj1k",
    sheetId: 1311308937,
  },
  {
    label: "Two Wheeler",
    vehicleType: "Two Wheeler",
    spreadsheetId: "17bSwC075VjzpKiZKjfzPBSw-Q74oTWFHxxR1ZMBtnlQ",
    sheetId: 189722845,
  },
]);

// Used only when the historical Google Sheets have not been shared with the
// server account. This keeps allocation operational while surfacing a warning
// to the cashier; once sheet access is restored, live sheet data takes over.
const FALLBACK_VEHICLES = Object.freeze([
  ["Eco- HR 55 AL 4922", "Four Wheeler", "sanjay@gmail.com"],
  ["Wagon r- HR 98 J 2273", "Four Wheeler", "modesigns.syadav@gmail.com"],
  ["Desire- HR 98 E 7168", "Four Wheeler", "brijeshshingyy@gmail.com"],
  ["Kia- HR 98 K 9030", "Four Wheeler", "akhileshmofitter@gmail.com"],
  ["Desire- HR 7940", "Four Wheeler", "ranjan@modesigns.in"],
  ["HR 98 N 8069", "Two Wheeler", ""],
  ["HR 98 B 7814", "Two Wheeler", "sanjaydas@modesigns.in"],
  ["HR 98 N 8893", "Two Wheeler", "mofurnishing9971127532@gmail.com"],
  ["HR 98 N 6997", "Two Wheeler", "pattelajitkumar@gmail.com"],
  ["HR 98 N 9078", "Two Wheeler", "pramod@modesigns.in"],
  ["HR 98 N 2628", "Two Wheeler", "bhadohivikasyadav@gmail.com"],
  ["HR 98 V 4672", "Two Wheeler", "op.singh@curtainsandcarpets.com"],
  ["HR 98 A 0544", "Two Wheeler", "bablu@modesigns.in"],
  ["HR 98 A 6467", "Two Wheeler", "modesignsharish.yadav@gmail.com"],
  ["HR 98 N 5689", "Two Wheeler", "movinody@gmail.com"],
  ["HR 98 N 5312", "Two Wheeler", "modesignsprivatelimited@gmail.com"],
  ["HR 98 H 5294", "Two Wheeler", "murari@gmail.com"],
  ["HR 98 N 1761", "Two Wheeler", "satendar.mospace@gmail.com"],
  ["HR 98 N 9983", "Two Wheeler", "pritamsingh@modesigns.in"],
  ["HR 98 B 5971", "Two Wheeler", "sanjaypatel@modesigns.in"],
  ["HR 98 B 2893", "Two Wheeler", ""],
  ["HR 98 A 4094", "Two Wheeler", ""],
].map(([vehicleNumber, vehicleType, email]) => ({
  vehicleNumber,
  vehicleType,
  email,
  sourceLabel: "MoTrack vehicle directory",
  source: "fallback_directory",
})));

const EMAIL_HEADER_ALIASES = new Set([
  "email",
  "mail",
  "email id",
  "emailid",
  "email address",
  "login email",
  "login mail",
  "work email",
]);

const VEHICLE_NUMBER_HEADER_ALIASES = new Set([
  "vehicle no",
  "vehicle number",
  "vehicleno",
  "vehicle registration no",
  "vehicle registration number",
  "registration no",
  "registration number",
  "bike no",
  "car no",
  "\u0935\u093e\u0939\u0928 \u0938\u0902\u0916\u094d\u092f\u093e \u090f\u0935\u0902 \u0928\u093e\u092e",
  "\u0935\u093e\u0939\u0928 \u0938\u0902\u0916\u094d\u092f\u093e",
  "\u0935\u093e\u0939\u0928 \u0928\u0902\u092c\u0930",
  "\u0935\u093e\u0939\u0928 \u0928\u092e\u094d\u092c\u0930",
]);

function base64url(input) {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function normalizeValue(value) {
  return String(value || "").trim();
}

function normalizeEmail(value) {
  return normalizeValue(value).toLowerCase();
}

function normalizeHeader(value) {
  return normalizeValue(value)
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/[^\w\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function parseCsv(csvText) {
  const rows = [];
  let row = [];
  let cell = "";
  let inQuotes = false;

  for (let index = 0; index < csvText.length; index += 1) {
    const char = csvText[index];
    const nextChar = csvText[index + 1];

    if (char === '"') {
      if (inQuotes && nextChar === '"') {
        cell += '"';
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (!inQuotes && char === ",") {
      row.push(cell);
      cell = "";
      continue;
    }

    if (!inQuotes && (char === "\n" || char === "\r")) {
      if (char === "\r" && nextChar === "\n") {
        index += 1;
      }
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      continue;
    }

    cell += char;
  }

  if (cell.length || row.length) {
    row.push(cell);
    rows.push(row);
  }

  return rows.filter((entry) => entry.some((cellValue) => normalizeValue(cellValue)));
}

function loadServiceAccount(rootDir) {
  const keyPath = path.join(rootDir, SERVICE_ACCOUNT_FILENAME);
  if (!fs.existsSync(keyPath)) {
    return null;
  }
  return JSON.parse(fs.readFileSync(keyPath, "utf8"));
}

function getServiceAccountEmail(rootDir) {
  const serviceAccount = loadServiceAccount(rootDir);
  return serviceAccount && serviceAccount.client_email ? serviceAccount.client_email : null;
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
    throw new Error(`Could not get Google Sheets access token: ${data.error || JSON.stringify(data)}`);
  }
  return data.access_token;
}

async function getSpreadsheetMeta(token, spreadsheetId) {
  const response = await fetch(`${SHEETS_API_BASE}/${spreadsheetId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data?.error?.message || `Could not read spreadsheet ${spreadsheetId}`);
  }
  return data;
}

function resolveSheetTitle(meta, sheetId) {
  const matchedSheet = (meta.sheets || []).find(
    (sheet) => Number(sheet.properties && sheet.properties.sheetId) === Number(sheetId)
  );
  if (!matchedSheet) {
    throw new Error(`Could not find sheet tab for gid ${sheetId}.`);
  }
  return matchedSheet.properties.title;
}

async function readRowsViaSheetsApi(rootDir, config) {
  const serviceAccount = loadServiceAccount(rootDir);
  if (!serviceAccount) {
    throw new Error("service-account-key.json is missing");
  }

  const token = await getAccessToken(serviceAccount);
  const meta = await getSpreadsheetMeta(token, config.spreadsheetId);
  const sheetTitle = resolveSheetTitle(meta, config.sheetId);
  const encodedRange = encodeURIComponent(`'${sheetTitle}'`);
  const response = await fetch(`${SHEETS_API_BASE}/${config.spreadsheetId}/values/${encodedRange}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data?.error?.message || `Could not read values from "${sheetTitle}"`);
  }
  return Array.isArray(data.values) ? data.values : [];
}

async function readRowsViaPublicCsv(config) {
  const response = await fetch(
    `https://docs.google.com/spreadsheets/d/${config.spreadsheetId}/export?format=csv&gid=${config.sheetId}`
  );
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`public CSV export returned ${response.status}`);
  }
  return parseCsv(text);
}

async function readVehicleSheetRows(rootDir, config) {
  const failures = [];

  try {
    const rows = await readRowsViaPublicCsv(config);
    return { rows, source: "public_csv" };
  } catch (error) {
    failures.push(`public CSV export unavailable (${error.message})`);
  }

  try {
    const rows = await readRowsViaSheetsApi(rootDir, config);
    return { rows, source: "service_account" };
  } catch (error) {
    failures.push(`service account access unavailable (${error.message})`);
  }

  throw new Error(failures.join("; "));
}

function isEmailHeader(header) {
  const raw = normalizeValue(header).toLowerCase();
  const normalized = normalizeHeader(header);
  return (
    EMAIL_HEADER_ALIASES.has(normalized)
    || normalized.includes("email")
    || normalized.includes("mail")
    || raw.includes("email")
  );
}

function isVehicleNumberHeader(header) {
  const raw = normalizeValue(header).toLowerCase();
  const normalized = normalizeHeader(header);
  if (VEHICLE_NUMBER_HEADER_ALIASES.has(normalized) || VEHICLE_NUMBER_HEADER_ALIASES.has(raw)) {
    return true;
  }

  if (
    raw.includes("\u0935\u093e\u0939\u0928")
    && (
      raw.includes("\u0938\u0902\u0916\u094d\u092f\u093e")
      || raw.includes("\u0928\u0902\u092c\u0930")
      || raw.includes("\u0928\u092e\u094d\u092c\u0930")
    )
  ) {
    return true;
  }

  return (
    (normalized.includes("vehicle") || normalized.includes("registration") || normalized.includes("bike") || normalized.includes("car"))
    && (normalized.includes("no") || normalized.includes("number"))
  );
}

function detectColumnIndex(headers, matcher) {
  return headers.findIndex((header) => matcher(header));
}

function getAssignmentsFromRows(rows, config) {
  const headers = Array.isArray(rows[0]) ? rows[0] : [];
  const emailIndex = detectColumnIndex(headers, isEmailHeader);
  const vehicleNumberIndex = detectColumnIndex(headers, isVehicleNumberHeader);

  if (emailIndex < 0 || vehicleNumberIndex < 0) {
    throw new Error(
      `Could not find both email and vehicle-number columns in ${config.label}. Found headers: ${headers.join(", ")}`
    );
  }

  return rows.slice(1).map((row) => ({
    email: normalizeEmail(row[emailIndex]),
    vehicleNumber: normalizeValue(row[vehicleNumberIndex]),
    vehicleType: config.vehicleType,
    sourceLabel: config.label,
  })).filter((entry) => entry.email && entry.vehicleNumber);
}

async function lookupVehicleAssignment(rootDir, email) {
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail) {
    return { match: null, warnings: [] };
  }

  const warnings = [];

  for (const config of VEHICLE_SHEETS) {
    try {
      const { rows, source } = await readVehicleSheetRows(rootDir, config);
      const assignments = getAssignmentsFromRows(rows, config);
      const match = assignments.find((entry) => entry.email === normalizedEmail);
      if (match) {
        return {
          match: {
            ...match,
            source,
          },
          warnings,
        };
      }
    } catch (error) {
      warnings.push(`${config.label}: ${error.message}`);
    }
  }

  const serviceAccountEmail = getServiceAccountEmail(rootDir);
  const inaccessibleWarnings = warnings.filter((warning) =>
    warning.includes("public CSV export unavailable") || warning.includes("service account access unavailable")
  );

  if (inaccessibleWarnings.length === VEHICLE_SHEETS.length) {
    const shareHint = serviceAccountEmail
      ? ` Share both sheets with ${serviceAccountEmail} as Viewer or Editor, or make the tabs publicly readable.`
      : " Add service-account-key.json or make the tabs publicly readable.";
    throw new Error(`Could not access the vehicle sheets.${shareHint}`);
  }

  return { match: null, warnings };
}

// The reading sheets are the company vehicle directory. Keep one entry per
// registration number so the cashier can see the fleet even when a vehicle
// appears in many historical meter-reading rows.
async function listVehicleAssignments(rootDir) {
  const warnings = [];
  const vehiclesByNumber = new Map();

  for (const config of VEHICLE_SHEETS) {
    try {
      const { rows, source } = await readVehicleSheetRows(rootDir, config);
      getAssignmentsFromRows(rows, config).forEach((entry) => {
        const key = entry.vehicleNumber.toLowerCase();
        if (!vehiclesByNumber.has(key)) {
          vehiclesByNumber.set(key, { ...entry, source });
        }
      });
    } catch (error) {
      warnings.push(`${config.label}: ${error.message}`);
    }
  }

  if (!vehiclesByNumber.size) {
    return {
      vehicles: [...FALLBACK_VEHICLES],
      warnings: ["Live vehicle Sheets are unavailable. Showing the saved MoTrack vehicle directory."],
    };
  }

  return {
    vehicles: [...vehiclesByNumber.values()].sort((left, right) =>
      left.vehicleNumber.localeCompare(right.vehicleNumber)
    ),
    warnings,
  };
}

module.exports = {
  getServiceAccountEmail,
  listVehicleAssignments,
  lookupVehicleAssignment,
};
