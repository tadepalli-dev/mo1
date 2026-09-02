// One-time identity migration for Umesh. It preserves his user record and
// every assigned task while replacing the old login address everywhere.
const path = require("path");
const admin = require("firebase-admin");
const { getFirestore } = require("firebase-admin/firestore");
const { DatabaseSync } = require("node:sqlite");
const firestoreStore = require("../lib/firestore-store");

const ROOT = path.join(__dirname, "..");
const STORE_COLLECTION = "motrack_store";
const OLD_EMAIL = "ups021980@gmail.com";
const NEW_EMAIL = "modesignsumesh@gmail.com";

function migrateEmail(users, tasks) {
  const oldUser = users.find((user) => String(user.email || "").toLowerCase() === OLD_EMAIL);
  const targetUser = users.find((user) => String(user.email || "").toLowerCase() === NEW_EMAIL);
  if (!oldUser) {
    if (targetUser) {
      return { updatedUsers: users, updatedTasks: tasks, updatedTaskCount: 0 };
    }
    throw new Error(`No user was found for ${OLD_EMAIL}.`);
  }
  if (targetUser) {
    throw new Error(`${NEW_EMAIL} is already assigned to another user.`);
  }

  const updatedUsers = users.map((user) =>
    String(user.email || "").toLowerCase() === OLD_EMAIL ? { ...user, email: NEW_EMAIL } : user
  );
  const updatedTasks = tasks.map((task) =>
    String(task.assigneeEmail || "").toLowerCase() === OLD_EMAIL
      ? { ...task, assigneeEmail: NEW_EMAIL }
      : task
  );
  return { updatedUsers, updatedTasks, updatedTaskCount: updatedTasks.filter((task, index) => task !== tasks[index]).length };
}

function migrateLocalSqlite() {
  const database = new DatabaseSync(path.join(ROOT, "data", "motrack.db"));
  const getValue = database.prepare("SELECT value FROM kv_store WHERE key = ?");
  const setValue = database.prepare("UPDATE kv_store SET value = ?, updated_at = ? WHERE key = ?");
  const users = JSON.parse(getValue.get("users").value);
  const tasks = JSON.parse(getValue.get("tasks").value);
  const { updatedUsers, updatedTasks, updatedTaskCount } = migrateEmail(users, tasks);
  const now = new Date().toISOString();
  setValue.run(JSON.stringify(updatedUsers), now, "users");
  setValue.run(JSON.stringify(updatedTasks), now, "tasks");
  return updatedTaskCount;
}

async function main() {
  const serviceAccount = require(path.join(ROOT, "service-account-key.json"));
  admin.initializeApp({ credential: admin.cert(serviceAccount) });
  const firestore = getFirestore();
  const [users, tasks] = await Promise.all([
    firestoreStore.readStoreValue(firestore, STORE_COLLECTION, "users", []),
    firestoreStore.readStoreValue(firestore, STORE_COLLECTION, "tasks", []),
  ]);

  const { updatedUsers, updatedTasks, updatedTaskCount } = migrateEmail(users, tasks);

  await Promise.all([
    firestoreStore.writeStoreValue(firestore, STORE_COLLECTION, "users", updatedUsers),
    firestoreStore.writeStoreValue(firestore, STORE_COLLECTION, "tasks", updatedTasks),
  ]);

  const localTaskCount = migrateLocalSqlite();
  console.log(`Updated Umesh login and ${updatedTaskCount} live task records plus ${localTaskCount} local task records.`);
}

main().catch((error) => {
  console.error("Umesh email migration failed:", error.message || error);
  process.exit(1);
});
