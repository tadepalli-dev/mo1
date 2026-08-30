// Fills in FMS_SALES_MeCA!B, D, E, and Converted every 15 minutes via
// Windows Task Scheduler. This used to be split between this Node script
// (E, Converted — needs Firestore) and a Google Apps Script trigger (B, D —
// only needs the Visitor Data sheet). The Apps Script side kept failing to
// stay properly bound to the spreadsheet (repeatedly ended up as a
// disconnected "Untitled project" with no working trigger), so B and D were
// folded in here too — one single automation the whole sheet depends on.
//
// B and D used to read from the Visitor Data spreadsheet's First_details
// tab, a manual mirror of the Walk-in Desk app's handovers. That mirror
// stopped receiving new rows (last entry: WALKIN-2283, 23 Aug), so B/D now
// read straight from the same Firestore `Walkin_Customer` collection the
// Walk-in Desk app itself uses — no separate sheet to fall out of sync.
//
// B = Total No Meeting Unique = unique customers (by mobile number) handed
// over (assignedAt) to each salesperson last week.
// D = Actual = same thing, but for TODAY only — resets to 0 every morning,
// not a week-to-date running total (deliberately different from B).
//
// E = total order amount for the CONVERTED customers only (same set as H,
// below) — not every order created that week. For each unique converted
// real-phone customer, E sums that customer's total order value across all
// of last week's orders (any deal type), so a "completed" walk-in that also
// placed a regular order still gets its real amount. For a placeholder-phone
// (no number on file) conversion coming from an invoiced Cashsale order, E
// uses that order's own amount directly. A placeholder-phone "completed"
// Raw_data row (rare) can't be reliably matched to one specific order out of
// many sharing the same placeholder number, so it contributes 0 — an
// accepted, narrow edge case.
//
// H = Converted = (Raw_data rows with Status="completed", last week) UNION
// (Firestore `orders` that are an instant sale — dealSnapshot.title is
// "Cashsale" OR "Walkin-sale" — created last week, attributed to that
// salesperson). Every instant-sale order counts here regardless of invoice
// status — invoicing is a downstream admin step, not a signal of whether
// the sale itself happened. Counting is by unique customer (phone number),
// so a customer with two instant-sale orders that week still counts once.
// The two sets are merged by customer phone number so the same customer
// isn't double-counted if they show up via both a completed walk-in row
// and an instant-sale order — except for the "0" placeholder phone (used
// across many different customers with no number on file), which is never
// deduped against itself.
//
// Usage:
//   node scripts/sync-fms-order-amount.js            # writes E and H columns
//   node scripts/sync-fms-order-amount.js --dry-run  # only prints values

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const admin = require("firebase-admin");
const { getFirestore } = require("firebase-admin/firestore");

const ROOT = path.join(__dirname, "..");
const DRY_RUN = process.argv.includes("--dry-run");
const SERVICE_ACCOUNT_PATH = path.join(ROOT, "service-account-key.json");
const SHEETS_API_BASE = "https://sheets.googleapis.com/v4/spreadsheets";
const SHEETS_API_SCOPE = "https://www.googleapis.com/auth/spreadsheets";

const FMS_SPREADSHEET_ID = "1xrGqVtGnazvWyLGg-Y6XOKydt-498SSfd73M9UhiR3U";
const FMS_SHEET_TITLE = "FMS";
const FMS_HEADER_ROW = 7;
const FMS_ROW_START = 8;
const FMS_ROW_END = 100;

function base64url(input) {
  return Buffer.from(input).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function loadServiceAccount() {
  return JSON.parse(fs.readFileSync(SERVICE_ACCOUNT_PATH, "utf8"));
}

async function getSheetsAccessToken(serviceAccount) {
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
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: jwt }),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(`Could not get a Google access token: ${JSON.stringify(data)}`);
  return data.access_token;
}

async function getValues(token, spreadsheetId, range) {
  const response = await fetch(`${SHEETS_API_BASE}/${spreadsheetId}/values/${encodeURIComponent(range)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data?.error?.message || `Could not read ${spreadsheetId} ${range}`);
  return data.values || [];
}

async function putValues(token, spreadsheetId, range, values) {
  const response = await fetch(`${SHEETS_API_BASE}/${spreadsheetId}/values/${encodeURIComponent(range)}?valueInputOption=RAW`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ values }),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data?.error?.message || `Could not write ${spreadsheetId} ${range}`);
  return data;
}

function getCurrentWeekBounds() {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const dayOfWeek = today.getDay();
  const diffToMonday = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
  const thisMonday = new Date(today);
  thisMonday.setDate(today.getDate() + diffToMonday);
  const nextMonday = new Date(thisMonday);
  nextMonday.setDate(thisMonday.getDate() + 7);
  return { weekStart: thisMonday, weekEndExclusive: nextMonday };
}

function getTodayBounds() {
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const tomorrowStart = new Date(todayStart);
  tomorrowStart.setDate(todayStart.getDate() + 1);
  return { dayStart: todayStart, dayEndExclusive: tomorrowStart };
}

function getLastWeekBounds() {
  const { weekStart: thisMonday } = getCurrentWeekBounds();
  const lastMonday = new Date(thisMonday);
  lastMonday.setDate(thisMonday.getDate() - 7);
  return { weekStart: lastMonday, weekEndExclusive: thisMonday };
}

// "0" is used as a placeholder for "no mobile entered" across many
// different customers (mostly quick cash sales) — it must never be treated
// as if it identifies one single repeat customer, or every anonymous
// customer collapses into a single "unique" count. Real mobile numbers still
// dedupe normally; each placeholder-mobile entry counts as its own customer.
function countUniqueCustomers(entries) {
  const realMobiles = new Set();
  let placeholderCount = 0;
  entries.forEach((entry) => {
    if (entry.mobile === "0") placeholderCount++;
    else realMobiles.add(entry.mobile);
  });
  return realMobiles.size + placeholderCount;
}

function normalizeName(value) {
  return String(value || "").trim().toUpperCase();
}

function normalizePhone(value) {
  return String(value || "").replace(/\D/g, "");
}

// "0000000000" (or blank) is a placeholder used across many different
// customers with no real number on file — never dedupe these against each
// other, or every anonymous customer collapses into one.
function isPlaceholderPhone(digits) {
  return !digits || /^0+$/.test(digits);
}

function parseTimestamp(value) {
  if (!value) return null;
  const match = String(value).trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if (!match) return null;
  const [, day, month, year, hour, minute, second] = match;
  return new Date(Number(year), Number(month) - 1, Number(day), Number(hour || 0), Number(minute || 0), Number(second || 0));
}

function columnIndexToLetter(index) {
  let letter = "";
  let n = index;
  while (n > 0) {
    const rem = (n - 1) % 26;
    letter = String.fromCharCode(65 + rem) + letter;
    n = Math.floor((n - 1) / 26);
  }
  return letter;
}

function findColumnByHeader(headerRow, headerText) {
  const target = headerText.trim().toLowerCase();
  const index = headerRow.findIndex((h) => String(h || "").trim().toLowerCase() === target);
  if (index === -1) throw new Error(`Could not find column header "${headerText}"`);
  return index + 1; // 1-based
}

async function main() {
  const serviceAccount = loadServiceAccount();
  admin.initializeApp({ credential: admin.cert(serviceAccount) });
  const firestore = getFirestore();
  const sheetsToken = await getSheetsAccessToken(serviceAccount);

  const headerRow = (await getValues(sheetsToken, FMS_SPREADSHEET_ID, `'${FMS_SHEET_TITLE}'!A${FMS_HEADER_ROW}:Z${FMS_HEADER_ROW}`))[0];
  const uniqueMeetingCol = findColumnByHeader(headerRow, "Total No Meeting Unique");
  const actualMeetingCol = uniqueMeetingCol + 2; // Total No Meeting Unique, Planned, Actual
  const orderAmountCol = findColumnByHeader(headerRow, "Total order amount");
  const convertedCol = findColumnByHeader(headerRow, "Converted");
  const uniqueMeetingLetter = columnIndexToLetter(uniqueMeetingCol);
  const actualMeetingLetter = columnIndexToLetter(actualMeetingCol);
  const orderAmountLetter = columnIndexToLetter(orderAmountCol);
  const convertedLetter = columnIndexToLetter(convertedCol);
  console.log(
    `Columns — Total No Meeting Unique: ${uniqueMeetingLetter}, Actual: ${actualMeetingLetter}, Total order amount: ${orderAmountLetter}, Converted: ${convertedLetter}`
  );

  const salesmenRows = await getValues(sheetsToken, FMS_SPREADSHEET_ID, `'${FMS_SHEET_TITLE}'!A${FMS_ROW_START}:A${FMS_ROW_END}`);

  const { weekStart, weekEndExclusive } = getLastWeekBounds();
  const weekStartISO = weekStart.toISOString();
  const weekEndISO = weekEndExclusive.toISOString();
  console.log(`Last week window: ${weekStart.toDateString()} to ${weekEndExclusive.toDateString()} (exclusive)`);

  const snapshot = await firestore
    .collection("orders")
    .where("createdAt", ">=", weekStartISO)
    .where("createdAt", "<", weekEndISO)
    .get();
  console.log(`Orders created last week: ${snapshot.size}`);

  // Per salesperson: total order value for every real phone number seen in
  // ANY order last week (regardless of deal type) — used to look up the
  // real amount for a "completed" Raw_data row's customer.
  const orderTotalByNameAndPhone = {};
  // Per salesperson: converted real phones -> amount, and a list of
  // individual placeholder-phone conversion amounts.
  const convertedRealPhoneAmounts = {};
  const convertedPlaceholderAmounts = {};

  function recordConversion(name, phoneRaw, amount) {
    if (!name) return;
    const digits = normalizePhone(phoneRaw);
    if (isPlaceholderPhone(digits)) {
      if (!convertedPlaceholderAmounts[name]) convertedPlaceholderAmounts[name] = [];
      convertedPlaceholderAmounts[name].push(amount || 0);
    } else if (!convertedRealPhoneAmounts[name] || !convertedRealPhoneAmounts[name].has(digits)) {
      if (!convertedRealPhoneAmounts[name]) convertedRealPhoneAmounts[name] = new Map();
      convertedRealPhoneAmounts[name].set(digits, amount || 0);
    }
  }

  const INSTANT_SALE_TITLES = new Set(["Cashsale", "Walkin-sale"]);
  let instantSaleCount = 0;
  snapshot.forEach((doc) => {
    const data = doc.data();
    const name = normalizeName(data.salesPerson);
    if (!name) return;
    const amount = typeof data.totalAmount === "number" ? data.totalAmount : 0;

    const phoneDigits = normalizePhone(data.customerPhone);
    if (!isPlaceholderPhone(phoneDigits)) {
      if (!orderTotalByNameAndPhone[name]) orderTotalByNameAndPhone[name] = new Map();
      const existing = orderTotalByNameAndPhone[name].get(phoneDigits) || 0;
      orderTotalByNameAndPhone[name].set(phoneDigits, existing + amount);
    }

    const isInstantSale = data.dealSnapshot && INSTANT_SALE_TITLES.has(data.dealSnapshot.title);
    if (!isInstantSale) return;
    instantSaleCount++;
    recordConversion(name, data.customerPhone, amount);
  });
  console.log(`Instant-sale orders counted (regardless of invoice status): ${instantSaleCount}`);

  const rawRows = await getValues(sheetsToken, FMS_SPREADSHEET_ID, "'Raw_data'!A2:K20000");
  rawRows.forEach((row) => {
    const ts = parseTimestamp(row[0]);
    if (!ts || ts < weekStart || ts >= weekEndExclusive) return;
    const name = normalizeName(row[9]);
    const status = String(row[10] || "").trim().toLowerCase();
    if (!name || status !== "completed") return;
    const phoneDigits = normalizePhone(row[2]);
    const matchedAmount = orderTotalByNameAndPhone[name] ? orderTotalByNameAndPhone[name].get(phoneDigits) || 0 : 0;
    recordConversion(name, row[2], matchedAmount);
  });

  // B and D — unique customers per salesperson, last week and TODAY only
  // (D resets to 0 every morning — it's a daily count, not week-to-date),
  // straight from the Walk-in Desk's live Firestore collection.
  const today = getTodayBounds();
  const walkinSnapshot = await firestore
    .collection("Walkin_Customer")
    .where("assignedAt", ">=", weekStartISO)
    .where("assignedAt", "<", today.dayEndExclusive.toISOString())
    .get();
  const visitorEntries = [];
  walkinSnapshot.forEach((doc) => {
    const data = doc.data();
    const ts = data.assignedAt ? new Date(data.assignedAt) : null;
    const mobile = String(data.mobile || "").trim();
    const handoverTo = normalizeName(data.salesmanName);
    if (ts && mobile && handoverTo) visitorEntries.push({ ts, mobile, handoverTo });
  });
  const visitorInLastWeek = visitorEntries.filter((e) => e.ts >= weekStart && e.ts < weekEndExclusive);
  const visitorToday = visitorEntries.filter((e) => e.ts >= today.dayStart && e.ts < today.dayEndExclusive);
  console.log(`Walk-ins handed over — last week: ${visitorInLastWeek.length}, today so far: ${visitorToday.length}`);

  const orderAmountValues = [];
  const convertedValues = [];
  const uniqueMeetingValues = [];
  const actualMeetingValues = [];
  salesmenRows.forEach((row) => {
    const name = normalizeName(row[0]);
    if (!name) {
      orderAmountValues.push([""]);
      convertedValues.push([""]);
      uniqueMeetingValues.push([""]);
      actualMeetingValues.push([""]);
      return;
    }

    const realPhoneMap = convertedRealPhoneAmounts[name];
    const placeholderList = convertedPlaceholderAmounts[name] || [];
    const realTotal = realPhoneMap ? [...realPhoneMap.values()].reduce((sum, v) => sum + v, 0) : 0;
    const placeholderTotal = placeholderList.reduce((sum, v) => sum + v, 0);
    orderAmountValues.push([Math.round((realTotal + placeholderTotal) * 100) / 100]);

    const realCount = realPhoneMap ? realPhoneMap.size : 0;
    const placeholderCount = placeholderList.length;
    convertedValues.push([realCount + placeholderCount]);

    uniqueMeetingValues.push([countUniqueCustomers(visitorInLastWeek.filter((e) => e.handoverTo === name))]);
    actualMeetingValues.push([countUniqueCustomers(visitorToday.filter((e) => e.handoverTo === name))]);
  });

  salesmenRows.forEach((row, index) => {
    const name = row[0];
    if (name) {
      console.log(
        `  ${name}: uniqueMeetings=${uniqueMeetingValues[index][0]} actual=${actualMeetingValues[index][0]} amount=${orderAmountValues[index][0]} converted=${convertedValues[index][0]}`
      );
    }
  });

  if (DRY_RUN) {
    console.log("\n--dry-run: not writing to the sheet.");
    return;
  }

  const rangeEnd = FMS_ROW_START + orderAmountValues.length - 1;
  await putValues(sheetsToken, FMS_SPREADSHEET_ID, `'${FMS_SHEET_TITLE}'!${uniqueMeetingLetter}${FMS_ROW_START}:${uniqueMeetingLetter}${rangeEnd}`, uniqueMeetingValues);
  await putValues(sheetsToken, FMS_SPREADSHEET_ID, `'${FMS_SHEET_TITLE}'!${actualMeetingLetter}${FMS_ROW_START}:${actualMeetingLetter}${rangeEnd}`, actualMeetingValues);
  await putValues(sheetsToken, FMS_SPREADSHEET_ID, `'${FMS_SHEET_TITLE}'!${orderAmountLetter}${FMS_ROW_START}:${orderAmountLetter}${rangeEnd}`, orderAmountValues);
  await putValues(sheetsToken, FMS_SPREADSHEET_ID, `'${FMS_SHEET_TITLE}'!${convertedLetter}${FMS_ROW_START}:${convertedLetter}${rangeEnd}`, convertedValues);
  console.log(`\nWrote ${orderAmountValues.length} values to ${uniqueMeetingLetter}, ${actualMeetingLetter}, ${orderAmountLetter}, and ${convertedLetter}.`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("Sync failed:", error.message);
    process.exit(1);
  });
