// Fills in FMS_SALES_MeCA!B, D, E, and Converted (Total No Meeting Unique,
// Actual, Total order amount, Converted) on a time-driven trigger, straight
// from Apps Script — a full port of scripts/sync-fms-order-amount.js from
// the old Node/Windows-Task-Scheduler setup. Runs entirely in Google's
// cloud, so it no longer depends on any particular PC being on.
//
// One-time setup:
//   1. Paste this file AND FirestoreRest.gs into an Apps Script project
//      (Extensions -> Apps Script from any sheet, or a standalone project —
//      either works, since everything below opens the spreadsheet by ID).
//   2. Follow the setup comment at the top of FirestoreRest.gs to set the
//      three FIRESTORE_* script properties from service-account-key.json.
//   3. Run createFmsSyncTrigger() once (Run menu -> select it -> Run). It
//      installs a 5-minute time-driven trigger that calls
//      syncFmsOrderAmount() from then on. The first run will prompt you to
//      authorize the script's Google account access to Sheets/UrlFetch —
//      approve it.
//   4. To test without writing anything, run dryRunFmsOrderAmount() and
//      check View -> Logs (or Executions) for the numbers it would write.
//
// B and D read straight from the Walk-in Desk's live `Walkin_Customer`
// Firestore collection (matched to a salesperson via assignedAt +
// salesmanName) — not from any spreadsheet mirror, so there's nothing else
// that can fall out of sync.
//
// B = Total No Meeting Unique = unique customers (by mobile number) handed
// over (assignedAt) to each salesperson last week.
// D = Actual = same thing, but for the current week (in progress).
//
// E = total order amount for the CONVERTED customers only (same set as
// Converted, below) — not every order created that week. For each unique
// converted real-phone customer, E sums that customer's total order value
// across all of last week's orders (any deal type), so a "completed"
// walk-in that also placed a regular order still gets its real amount. For
// a placeholder-phone (no number on file) conversion coming from an
// invoiced Cashsale order, E uses that order's own amount directly. A
// placeholder-phone "completed" Raw_data row (rare) can't be reliably
// matched to one specific order out of many sharing the same placeholder
// number, so it contributes 0 — an accepted, narrow edge case.
//
// Converted = (Raw_data rows with Status="completed", last week) UNION
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

const FMS_SPREADSHEET_ID_ = "1xrGqVtGnazvWyLGg-Y6XOKydt-498SSfd73M9UhiR3U";
const FMS_SHEET_TITLE_ = "FMS";
const FMS_HEADER_ROW_ = 7;
const FMS_ROW_START_ = 8;
const FMS_ROW_END_ = 100;
const INSTANT_SALE_TITLES_ = ["Cashsale", "Walkin-sale"];

function createFmsSyncTrigger() {
  ScriptApp.getProjectTriggers()
    .filter((t) => t.getHandlerFunction() === "syncFmsOrderAmount")
    .forEach((t) => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger("syncFmsOrderAmount").timeBased().everyMinutes(5).create();
  Logger.log("Installed a 5-minute trigger for syncFmsOrderAmount.");
}

function dryRunFmsOrderAmount() {
  runFmsSync_(true);
}

function syncFmsOrderAmount() {
  runFmsSync_(false);
}

function getCurrentWeekBounds_() {
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

function getLastWeekBounds_() {
  const thisMonday = getCurrentWeekBounds_().weekStart;
  const lastMonday = new Date(thisMonday);
  lastMonday.setDate(thisMonday.getDate() - 7);
  return { weekStart: lastMonday, weekEndExclusive: thisMonday };
}

// "0" is used as a placeholder for "no mobile entered" across many
// different customers (mostly quick cash sales) — it must never be treated
// as if it identifies one single repeat customer, or every anonymous
// customer collapses into a single "unique" count. Real mobile numbers still
// dedupe normally; each placeholder-mobile entry counts as its own customer.
function countUniqueCustomers_(entries) {
  const realMobiles = new Set();
  let placeholderCount = 0;
  entries.forEach((entry) => {
    if (entry.mobile === "0") placeholderCount++;
    else realMobiles.add(entry.mobile);
  });
  return realMobiles.size + placeholderCount;
}

function normalizeName_(value) {
  return String(value || "").trim().toUpperCase();
}

function normalizePhone_(value) {
  return String(value || "").replace(/\D/g, "");
}

// "0000000000" (or blank) is a placeholder used across many different
// customers with no real number on file — never dedupe these against each
// other, or every anonymous customer collapses into one.
function isPlaceholderPhone_(digits) {
  return !digits || /^0+$/.test(digits);
}

// Raw_data timestamps come from a Google Form and read back as either JS
// Date objects (Apps Script auto-converts date-looking cells) or, if the
// column is formatted as plain text, "DD/MM/YYYY[ HH:mm[:ss]]" strings.
// Handle both.
function parseTimestamp_(value) {
  if (!value) return null;
  if (Object.prototype.toString.call(value) === "[object Date]") return value;
  const match = String(value)
    .trim()
    .match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if (!match) return null;
  const day = Number(match[1]);
  const month = Number(match[2]);
  const year = Number(match[3]);
  const hour = Number(match[4] || 0);
  const minute = Number(match[5] || 0);
  const second = Number(match[6] || 0);
  return new Date(year, month - 1, day, hour, minute, second);
}

function findColumnByHeader_(headerRow, headerText) {
  const target = headerText.trim().toLowerCase();
  const index = headerRow.findIndex((h) => String(h || "").trim().toLowerCase() === target);
  if (index === -1) throw new Error('Could not find column header "' + headerText + '"');
  return index + 1; // 1-based
}

function runFmsSync_(dryRun) {
  const spreadsheet = SpreadsheetApp.openById(FMS_SPREADSHEET_ID_);
  const fmsSheet = spreadsheet.getSheetByName(FMS_SHEET_TITLE_);

  const headerRow = fmsSheet.getRange(FMS_HEADER_ROW_, 1, 1, fmsSheet.getLastColumn()).getValues()[0];
  const uniqueMeetingCol = findColumnByHeader_(headerRow, "Total No Meeting Unique");
  const actualMeetingCol = uniqueMeetingCol + 2; // Total No Meeting Unique, Planned, Actual
  const orderAmountCol = findColumnByHeader_(headerRow, "Total order amount");
  const convertedCol = findColumnByHeader_(headerRow, "Converted");
  Logger.log(
    "Columns (1-based) — Total No Meeting Unique: " +
      uniqueMeetingCol +
      ", Actual: " +
      actualMeetingCol +
      ", Total order amount: " +
      orderAmountCol +
      ", Converted: " +
      convertedCol
  );

  const numSalesmenRows = FMS_ROW_END_ - FMS_ROW_START_ + 1;
  const salesmenRows = fmsSheet.getRange(FMS_ROW_START_, 1, numSalesmenRows, 1).getValues();

  const lastWeek = getLastWeekBounds_();
  const weekStart = lastWeek.weekStart;
  const weekEndExclusive = lastWeek.weekEndExclusive;
  const weekStartISO = weekStart.toISOString();
  const weekEndISO = weekEndExclusive.toISOString();
  Logger.log("Last week window: " + weekStart.toDateString() + " to " + weekEndExclusive.toDateString() + " (exclusive)");

  const orders = queryFirestoreCollection_(
    "orders",
    [
      { field: "createdAt", op: "GREATER_THAN_OR_EQUAL", value: weekStartISO },
      { field: "createdAt", op: "LESS_THAN", value: weekEndISO },
    ],
    5000
  );
  Logger.log("Orders created last week: " + orders.length);

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
    const digits = normalizePhone_(phoneRaw);
    if (isPlaceholderPhone_(digits)) {
      if (!convertedPlaceholderAmounts[name]) convertedPlaceholderAmounts[name] = [];
      convertedPlaceholderAmounts[name].push(amount || 0);
    } else {
      if (!convertedRealPhoneAmounts[name]) convertedRealPhoneAmounts[name] = {};
      if (!(digits in convertedRealPhoneAmounts[name])) {
        convertedRealPhoneAmounts[name][digits] = amount || 0;
      }
    }
  }

  let instantSaleCount = 0;
  orders.forEach((order) => {
    const data = order.data;
    const name = normalizeName_(data.salesPerson);
    if (!name) return;
    const amount = typeof data.totalAmount === "number" ? data.totalAmount : 0;

    const phoneDigits = normalizePhone_(data.customerPhone);
    if (!isPlaceholderPhone_(phoneDigits)) {
      if (!orderTotalByNameAndPhone[name]) orderTotalByNameAndPhone[name] = {};
      const existing = orderTotalByNameAndPhone[name][phoneDigits] || 0;
      orderTotalByNameAndPhone[name][phoneDigits] = existing + amount;
    }

    const isInstantSale = data.dealSnapshot && INSTANT_SALE_TITLES_.indexOf(data.dealSnapshot.title) !== -1;
    if (!isInstantSale) return;
    instantSaleCount++;
    recordConversion(name, data.customerPhone, amount);
  });
  Logger.log("Instant-sale orders counted (regardless of invoice status): " + instantSaleCount);

  const rawSheet = spreadsheet.getSheetByName("Raw_data");
  const rawLastRow = rawSheet.getLastRow();
  if (rawLastRow > 1) {
    const rawRows = rawSheet.getRange(2, 1, rawLastRow - 1, 11).getValues();
    rawRows.forEach((row) => {
      const ts = parseTimestamp_(row[0]);
      if (!ts || ts < weekStart || ts >= weekEndExclusive) return;
      const name = normalizeName_(row[9]);
      const status = String(row[10] || "").trim().toLowerCase();
      if (!name || status !== "completed") return;
      const phoneDigits = normalizePhone_(row[2]);
      const matchedAmount = (orderTotalByNameAndPhone[name] && orderTotalByNameAndPhone[name][phoneDigits]) || 0;
      recordConversion(name, row[2], matchedAmount);
    });
  }

  // B and D — unique customers per salesperson, last week and this week,
  // straight from the Walk-in Desk's live Firestore collection.
  const currentWeek = getCurrentWeekBounds_();
  const walkins = queryFirestoreCollection_(
    "Walkin_Customer",
    [
      { field: "assignedAt", op: "GREATER_THAN_OR_EQUAL", value: weekStartISO },
      { field: "assignedAt", op: "LESS_THAN", value: currentWeek.weekEndExclusive.toISOString() },
    ],
    5000
  );
  const visitorEntries = [];
  walkins.forEach((walkin) => {
    const data = walkin.data;
    const ts = data.assignedAt ? new Date(data.assignedAt) : null;
    const mobile = String(data.mobile || "").trim();
    const handoverTo = normalizeName_(data.salesmanName);
    if (ts && mobile && handoverTo) visitorEntries.push({ ts: ts, mobile: mobile, handoverTo: handoverTo });
  });
  const visitorInLastWeek = visitorEntries.filter((e) => e.ts >= weekStart && e.ts < weekEndExclusive);
  const visitorInThisWeek = visitorEntries.filter((e) => e.ts >= currentWeek.weekStart && e.ts < currentWeek.weekEndExclusive);
  Logger.log("Walk-ins handed over — last week: " + visitorInLastWeek.length + ", this week so far: " + visitorInThisWeek.length);

  const orderAmountValues = [];
  const convertedValues = [];
  const uniqueMeetingValues = [];
  const actualMeetingValues = [];
  salesmenRows.forEach((row) => {
    const name = normalizeName_(row[0]);
    if (!name) {
      orderAmountValues.push([""]);
      convertedValues.push([""]);
      uniqueMeetingValues.push([""]);
      actualMeetingValues.push([""]);
      return;
    }

    const realPhoneMap = convertedRealPhoneAmounts[name] || {};
    const realPhoneKeys = Object.keys(realPhoneMap);
    const placeholderList = convertedPlaceholderAmounts[name] || [];
    const realTotal = realPhoneKeys.reduce((sum, key) => sum + realPhoneMap[key], 0);
    const placeholderTotal = placeholderList.reduce((sum, v) => sum + v, 0);
    orderAmountValues.push([Math.round((realTotal + placeholderTotal) * 100) / 100]);

    convertedValues.push([realPhoneKeys.length + placeholderList.length]);

    uniqueMeetingValues.push([countUniqueCustomers_(visitorInLastWeek.filter((e) => e.handoverTo === name))]);
    actualMeetingValues.push([countUniqueCustomers_(visitorInThisWeek.filter((e) => e.handoverTo === name))]);
  });

  salesmenRows.forEach((row, index) => {
    const name = row[0];
    if (name) {
      Logger.log(
        "  " +
          name +
          ": uniqueMeetings=" +
          uniqueMeetingValues[index][0] +
          " actual=" +
          actualMeetingValues[index][0] +
          " amount=" +
          orderAmountValues[index][0] +
          " converted=" +
          convertedValues[index][0]
      );
    }
  });

  if (dryRun) {
    Logger.log("Dry run — not writing to the sheet.");
    return;
  }

  fmsSheet.getRange(FMS_ROW_START_, uniqueMeetingCol, uniqueMeetingValues.length, 1).setValues(uniqueMeetingValues);
  fmsSheet.getRange(FMS_ROW_START_, actualMeetingCol, actualMeetingValues.length, 1).setValues(actualMeetingValues);
  fmsSheet.getRange(FMS_ROW_START_, orderAmountCol, orderAmountValues.length, 1).setValues(orderAmountValues);
  fmsSheet.getRange(FMS_ROW_START_, convertedCol, convertedValues.length, 1).setValues(convertedValues);
  Logger.log("Wrote " + orderAmountValues.length + " rows to the Total No Meeting Unique, Actual, Total order amount, and Converted columns.");
}
