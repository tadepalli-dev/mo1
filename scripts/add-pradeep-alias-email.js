// Pradeep's MoTrack login is pradeepparsipur@gmail.com, but the CRM's
// employee directory lists him under modesignspradeep@gmail.com (same code
// "CP", same designation "salesmanager") — he tried logging into MoTrack
// with that second email and got "not in the user list".
//
// Rather than replacing his canonical email (which would orphan the 300+
// tasks already assigned to the old address), this adds the CRM email as an
// alias. server.js/api/index.js's matchesUserEmail() now accepts either
// address at login/forgot-password, while every task, completion, and
// session still keys off the original canonical email untouched.
//
// Updates both the local dev DB and production Firestore, since they're
// separate stores (see api/index.js's Firestore-first / SQLite-fallback
// read/write path).
//
// Usage:
//   node scripts/add-pradeep-alias-email.js            # writes the change
//   node scripts/add-pradeep-alias-email.js --dry-run  # only prints what it would do

const path = require("path");
const { DatabaseSync } = require("node:sqlite");
const admin = require("firebase-admin");
const { getFirestore } = require("firebase-admin/firestore");

const DRY_RUN = process.argv.includes("--dry-run");
const DB_PATH = path.join(__dirname, "..", "data", "motrack.db");
const SERVICE_ACCOUNT_PATH = path.join(__dirname, "..", "service-account-key.json");
const FIRESTORE_STORE_COLLECTION = "motrack_store";

const CANONICAL_EMAIL = "pradeepparsipur@gmail.com";
const ALIAS_EMAIL = "modesignspradeep@gmail.com";

function addAlias(users) {
  let found = false;
  const updated = users.map((user) => {
    if (String(user.email || "").toLowerCase() !== CANONICAL_EMAIL) {
      return user;
    }
    found = true;
    const aliasEmails = Array.isArray(user.aliasEmails) ? user.aliasEmails : [];
    if (aliasEmails.some((alias) => String(alias).toLowerCase() === ALIAS_EMAIL)) {
      console.log("Alias already present — nothing to do for this store.");
      return user;
    }
    console.log(`Adding alias "${ALIAS_EMAIL}" to ${user.name} (${user.email}).`);
    return { ...user, aliasEmails: [...aliasEmails, ALIAS_EMAIL] };
  });

  if (!found) {
    console.log(`No user with email ${CANONICAL_EMAIL} found in this store.`);
  }
  return updated;
}

function updateLocalDb() {
  const db = new DatabaseSync(DB_PATH);
  const getStore = db.prepare("SELECT value FROM kv_store WHERE key = ?");
  const setStore = db.prepare(
    `INSERT INTO kv_store (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  );

  const users = JSON.parse(getStore.get("users").value || "[]");
  console.log("--- Local dev DB ---");
  const updated = addAlias(users);
  if (!DRY_RUN) {
    setStore.run("users", JSON.stringify(updated), new Date().toISOString());
    console.log("Local DB updated.");
  }
}

async function updateFirestore() {
  console.log("\n--- Production Firestore ---");
  const serviceAccount = require(SERVICE_ACCOUNT_PATH);
  admin.initializeApp({ credential: admin.cert(serviceAccount) });
  const firestore = getFirestore();

  const docRef = firestore.collection(FIRESTORE_STORE_COLLECTION).doc("users");
  const snapshot = await docRef.get();
  if (!snapshot.exists) {
    console.log("No 'users' document found in Firestore — nothing to update.");
    return;
  }

  const users = JSON.parse(snapshot.data().value || "[]");
  const updated = addAlias(users);
  if (!DRY_RUN) {
    await docRef.set({ value: JSON.stringify(updated), updated_at: new Date().toISOString() });
    console.log("Firestore updated.");
  }
}

async function main() {
  updateLocalDb();
  await updateFirestore();
  if (DRY_RUN) {
    console.log("\nDry run — nothing written.");
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("Failed:", error);
    process.exit(1);
  });
