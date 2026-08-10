# Syncing MoTrack data to Google Sheets (for Looker Studio)

Looker Studio can't read your local MoTrack server or its SQLite database
directly — it's a Google cloud service and your server only runs on this
PC. Instead, this script pushes a snapshot of your data (Tasks,
Completions, Users, Pantry Alerts) into a Google Sheet, and Looker Studio
reads from that Sheet using its built-in, no-code Sheets connector.

## One-time setup

### 1. Create a Google Cloud service account

1. Go to https://console.cloud.google.com/ and create a project (or pick an
   existing one).
2. In the search bar, find **"Google Sheets API"** and click **Enable**.
3. Go to **IAM & Admin → Service Accounts → Create Service Account**. Give
   it any name (e.g. "motrack-sheets-sync"). You don't need to grant it any
   project-level roles — click through to done.
4. Open the service account you just created → **Keys** tab → **Add Key →
   Create new key → JSON**. This downloads a `.json` file — save it into
   this project folder (`MO1/`), e.g. as `service-account-key.json`.
   **Do not share this file or commit it to git** — anyone with it can
   write to any sheet you grant it access to.
5. Open that JSON file and copy the `client_email` value (looks like
   `motrack-sheets-sync@your-project.iam.gserviceaccount.com`).

### 2. Create (or reuse) the target Google Sheet

1. Open your "Untitled spreadsheet" (or create a new one) at
   https://sheets.google.com.
2. Click **Share**, paste in the service account's `client_email` from
   step 1.5, and give it **Editor** access.
3. Copy the spreadsheet ID out of its URL:
   `https://docs.google.com/spreadsheets/d/`**`THIS_PART_IS_THE_ID`**`/edit`

### 3. Configure the script

1. In the `MO1/` folder, copy `sheets-config.example.json` to
   `sheets-config.json`.
2. Fill in:
   ```json
   {
     "spreadsheetId": "the ID you copied above",
     "serviceAccountKeyPath": "./service-account-key.json"
   }
   ```

## Running it

```
npm run sync-sheets
```

This creates (or reuses) four tabs — **Tasks**, **Completions**, **Users**,
**Pantry Alerts** — and overwrites them with the current database contents.
User passwords are never included.

To preview what would be synced without touching Google at all (useful for
checking your setup before doing the Google Cloud steps):

```
node scripts/sync-to-sheets.js --dry-run
```

## Connecting Looker Studio

1. In Looker Studio, **Create → Data source → Google Sheets**.
2. Pick the spreadsheet and the tab (e.g. "Tasks") you want to build a
   report from. Repeat per tab if you want multiple data sources.
3. Build your charts/tables as normal.

## Keeping it up to date

Run `npm run sync-sheets` whenever you want the Sheet (and therefore your
Looker Studio report) to reflect the latest data. If you want it to refresh
automatically instead of running it by hand, let me know and I can wire it
into the server as a periodic background job — the same pattern already
used for the leave-data refresh.

---

## Alternative: pulling via Google Apps Script (what we actually set up)

Instead of the push script above, this project can be set up so an
**Apps Script trigger pulls data from your MoTrack server** through the
stable Vercel deployment plus a dedicated, secret-key-gated read-only
endpoint (`/api/sheets-feed`) — never your real login token, and it never
includes passwords.

Using the Vercel URL avoids the repeated outage where free ngrok URLs go
offline or change after a restart.

### Setup

1. The server already generates a secret automatically. It's printed each
   time the server starts, and saved at `data/sheets-feed-secret.txt`.
2. In your Apps Script project (`Code.gs`), paste in the contents of
   `apps-script/Code.example.gs` from this folder, then fill in:
   - `MOTRACK_URL` — keep it as `https://motrack-app-mo.vercel.app`.
   - `MOTRACK_SECRET` — the secret from step 1.
   - `SPREADSHEET_ID` — from your Sheet's URL.
3. Run the `syncMoTrackToSheets` function once from the Apps Script editor
   (▶ Run). The first run will ask you to authorize the script — approve
   it. Check your Sheet — it should now have Tasks/Completions/Users/Pantry
   Alerts tabs.
4. To auto-refresh: in the Apps Script editor, click the clock icon
   ("Triggers") on the left → **Add Trigger** → function
   `syncMoTrackToSheets`, event source **Time-driven**, pick an interval
   (e.g. every 15 or 30 minutes).

Connect Looker Studio to the resulting Sheet the same way described above.

---

## Optional: a login-gated MoTrack viewer web app (Apps Script)

This is a small, separate web app — served directly by Apps Script, with
its own URL — that shows a read-only view of your MoTrack data (Tasks,
Completions, Users, Pantry Alerts) behind a real username/password login.
The login checks credentials against your actual MoTrack server (same
check the main app uses), not a copy stored in the Sheet.

**Worth knowing before you set this up:** when someone logs into this web
app, their password travels from their browser → Google's Apps Script
servers → the deployed MoTrack server. That's still a custom-login flow,
just without the instability of a temporary tunnel.

### Setup

1. In your Apps Script project, click the **+** next to "Files" → choose
   **Script** → name it `WebApp` → paste in the contents of
   `apps-script/WebApp.gs` from this folder.
2. Click **+** next to "Files" again → choose **HTML** → name it exactly
   `Index` (must match, it's how the code finds the page) → paste in the
   contents of `apps-script/Index.html` from this folder.
3. Save (Ctrl+S).
4. Click **Deploy → New deployment**. Click the gear icon next to "Select
   type" and choose **Web app**.
5. Set **Execute as: Me**. Set **Who has access: Anyone** (the login form
   is the actual access gate here, not Google's account picker).
6. Click **Deploy**, approve the authorization prompt if asked, then copy
   the **Web app URL** it gives you.
7. Open that URL in a browser tab and sign in with a real MoTrack email +
   password (e.g. `asha@modesigns.in` / `Asha99@`) to confirm it works.

Set `MOTRACK_URL` in the Apps Script project's `Code.gs` to
`https://motrack-app-mo.vercel.app` before deploying this web app. That
keeps the redirect stable instead of depending on an ngrok URL that can
expire within a day or two.
