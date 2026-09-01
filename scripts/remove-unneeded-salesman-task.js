// Deactivates an obsolete task across the shared task store. Keeping the
// records inactive preserves historic submissions while removing it from all
// current and future salesman dashboards.
const path = require("path");
const { DatabaseSync } = require("node:sqlite");
const admin = require("firebase-admin");
const { getFirestore } = require("firebase-admin/firestore");
const firestoreStore = require("../lib/firestore-store");

const DB_PATH = path.join(__dirname, "..", "data", "motrack.db");
const SERVICE_ACCOUNT_PATH = path.join(__dirname, "..", "service-account-key.json");
const STORE_COLLECTION = "motrack_store";
const OBSOLETE_TASK = /take input of customer requirement by google form on\s*t\.?v\.?/i;

async function main() {
  const serviceAccount = require(SERVICE_ACCOUNT_PATH);
  admin.initializeApp({ credential: admin.cert(serviceAccount) });
  const firestore = getFirestore();
  const db = new DatabaseSync(DB_PATH);
  const getStore = db.prepare("SELECT value FROM kv_store WHERE key = ?");
  const setStore = db.prepare(
    `INSERT INTO kv_store (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  );

  const localRow = getStore.get("tasks");
  const localTasks = localRow ? JSON.parse(localRow.value || "[]") : [];
  const remoteTasks = await firestoreStore.readStoreValue(firestore, STORE_COLLECTION, "tasks", null);
  const tasks = Array.isArray(remoteTasks) ? remoteTasks : localTasks;
  const removedAt = new Date().toISOString();
  let changed = 0;

  const updatedTasks = tasks.map((task) => {
    if (!OBSOLETE_TASK.test(String(task.title || task.checklistLabel || "")) || task.active === false) {
      return task;
    }
    changed += 1;
    return {
      ...task,
      active: false,
      deactivatedAt: removedAt,
      deactivationReason: "Obsolete salesman checklist task",
    };
  });

  await firestoreStore.writeStoreValue(firestore, STORE_COLLECTION, "tasks", updatedTasks);
  setStore.run("tasks", JSON.stringify(updatedTasks), removedAt);
  console.log(`Deactivated ${changed} obsolete task record(s).`);
}

main().catch((error) => {
  console.error("Task removal failed:", error);
  process.exit(1);
});
