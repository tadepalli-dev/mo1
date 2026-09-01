// Pushes the local SQLite store (data/motrack.db) into Firestore, which is
// what the hosted app on Vercel actually reads.
//
// Needed because the "tasks" key outgrew Firestore's 1 MB per-document limit,
// so every write to it failed and the document was never created. The hosted
// app then fell back to the SQLite snapshot bundled at deploy time and served
// a frozen copy of the data — walk-in customers handed over after the deploy
// had no Customer/Deal ID on the dashboard. lib/firestore-store.js now splits
// oversized values across chunk documents; this script does the one-time
// backfill (and is safe to re-run any time the two drift apart).
//
// Keys that already exist in Firestore are LEFT ALONE by default. Some of
// them (completions, absences) have been written live by the hosted app for
// weeks and are far ahead of the local file — "completions" was 298 KB in
// Firestore against 11 KB locally — so a blind push would wipe real data.
// Only --force overwrites, and only for keys named explicitly.
//
// Usage:
//   node scripts/push-store-to-firestore.js --dry-run     # report only
//   node scripts/push-store-to-firestore.js               # seed missing keys
//   node scripts/push-store-to-firestore.js tasks users   # seed named keys
//   node scripts/push-store-to-firestore.js tasks --force # overwrite one key

const path = require("path");
const { DatabaseSync } = require("node:sqlite");
const admin = require("firebase-admin");
const { getFirestore } = require("firebase-admin/firestore");
const firestoreStore = require("../lib/firestore-store");

const DB_PATH = path.join(__dirname, "..", "data", "motrack.db");
const SERVICE_ACCOUNT_PATH = path.join(__dirname, "..", "service-account-key.json");
const FIRESTORE_STORE_COLLECTION = "motrack_store";

const STORE_KEYS = [
  "users",
  "tasks",
  "deletedRequiredTasks",
  "completions",
  "absences",
  "pantryAlerts",
  "liveLocations",
  "passwordResetRequests",
];

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const FORCE = args.includes("--force");
const requestedKeys = args.filter((arg) => !arg.startsWith("--"));
const keysToPush = requestedKeys.length ? requestedKeys : STORE_KEYS;

async function main() {
  const unknown = keysToPush.filter((key) => !STORE_KEYS.includes(key));
  if (unknown.length) {
    throw new Error(`Unknown store key(s): ${unknown.join(", ")}`);
  }
  if (FORCE && !requestedKeys.length) {
    throw new Error("--force overwrites live data, so it only works on explicitly named keys.");
  }

  admin.initializeApp({ credential: admin.cert(require(SERVICE_ACCOUNT_PATH)) });
  const firestore = getFirestore();

  const db = new DatabaseSync(DB_PATH);
  const getStore = db.prepare("SELECT value, updated_at FROM kv_store WHERE key = ?");

  for (const key of keysToPush) {
    const row = getStore.get(key);
    if (!row) {
      console.log(`${key.padEnd(22)} not in SQLite — skipped`);
      continue;
    }

    const localBytes = Buffer.byteLength(row.value, "utf8");
    const remoteJson = await firestoreStore.readStoreJson(firestore, FIRESTORE_STORE_COLLECTION, key);
    const remoteLabel = remoteJson === null
      ? "absent in Firestore"
      : `${(Buffer.byteLength(remoteJson, "utf8") / 1024).toFixed(0)} KB in Firestore`;

    if (remoteJson === row.value) {
      console.log(`${key.padEnd(22)} already identical (${(localBytes / 1024).toFixed(0)} KB) — skipped`);
      continue;
    }

    if (remoteJson !== null && !FORCE) {
      console.log(
        `${key.padEnd(22)} Firestore already owns this key (${remoteLabel}) — skipped, pass --force to overwrite`
      );
      continue;
    }

    if (DRY_RUN) {
      console.log(
        `${key.padEnd(22)} would push ${(localBytes / 1024).toFixed(0)} KB (local ${row.updated_at}, ${remoteLabel})`
      );
      continue;
    }

    const result = await firestoreStore.writeStoreValue(
      firestore,
      FIRESTORE_STORE_COLLECTION,
      key,
      JSON.parse(row.value)
    );
    console.log(
      `${key.padEnd(22)} pushed ${(result.bytes / 1024).toFixed(0)} KB` +
        `${result.chunkCount ? ` across ${result.chunkCount} chunks` : ""} (was ${remoteLabel})`
    );
  }

  if (DRY_RUN) {
    console.log("\nDry run — nothing written.");
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("Push failed:", error);
    process.exit(1);
  });
