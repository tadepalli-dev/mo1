// Template — copy this file's contents into your Apps Script project's
// Code.gs, then fill in the two remaining constants below. For permanent
// use, point Apps Script at the stable Vercel deployment instead of a
// temporary ngrok tunnel.

const MOTRACK_URL = "https://motrack-app-mo.vercel.app";
const MOTRACK_SECRET = "PASTE_THE_SHEETS_FEED_SECRET_HERE"; // printed when the server starts, also in data/sheets-feed-secret.txt
const SPREADSHEET_ID = "PASTE_YOUR_SPREADSHEET_ID_HERE"; // from the Sheet's URL

function syncMoTrackToSheets() {
  const response = UrlFetchApp.fetch(
    MOTRACK_URL + "/api/sheets-feed?key=" + MOTRACK_SECRET,
    { muteHttpExceptions: true }
  );

  if (response.getResponseCode() !== 200) {
    throw new Error(
      "MoTrack feed returned " + response.getResponseCode() + ": " + response.getContentText()
    );
  }

  const data = JSON.parse(response.getContentText());
  const spreadsheet = SpreadsheetApp.openById(SPREADSHEET_ID);

  writeTab(spreadsheet, "Tasks", data.tasks);
  writeTab(
    spreadsheet,
    "Completions",
    Object.keys(data.completions).map((key) =>
      Object.assign({ completionKey: key }, data.completions[key])
    )
  );
  writeTab(spreadsheet, "Users", data.users);
  writeTab(spreadsheet, "Pantry Alerts", data.pantryAlerts);

  Logger.log("MoTrack sync complete: " + new Date());
}

function writeTab(spreadsheet, title, items) {
  let sheet = spreadsheet.getSheetByName(title);
  if (!sheet) {
    sheet = spreadsheet.insertSheet(title);
  }
  sheet.clearContents();

  if (!items || !items.length) {
    sheet.getRange(1, 1).setValue("(no data yet)");
    return;
  }

  const headerSet = {};
  items.forEach((item) => Object.keys(item).forEach((key) => (headerSet[key] = true)));
  const headers = Object.keys(headerSet);

  const rows = items.map((item) =>
    headers.map((key) => {
      const value = item[key];
      if (value === undefined || value === null) return "";
      if (typeof value === "object") return JSON.stringify(value);
      return value;
    })
  );

  sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  if (rows.length) {
    sheet.getRange(2, 1, rows.length, headers.length).setValues(rows);
  }
}
