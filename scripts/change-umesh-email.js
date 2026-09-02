// One-time identity migration for Umesh. It preserves his user record and
// every assigned task while replacing the old login address everywhere.
const path = require("path");
const admin = require("firebase-admin");
const { getFirestore } = require("firebase-admin/firestore");
const firestoreStore = require("../lib/firestore-store");

const ROOT = path.join(__dirname, "..");
const STORE_COLLECTION = "motrack_store";
const OLD_EMAIL = "ups021980@gmail.com";
const NEW_EMAIL = "modesignsumesh@gmail.com";

async function main() {
  const serviceAccount = require(path.join(ROOT, "service-account-key.json"));
  admin.initializeApp({ credential: admin.cert(serviceAccount) });
  const firestore = getFirestore();
  const [users, tasks] = await Promise.all([
    firestoreStore.readStoreValue(firestore, STORE_COLLECTION, "users", []),
    firestoreStore.readStoreValue(firestore, STORE_COLLECTION, "tasks", []),
  ]);

  const oldUser = users.find((user) => String(user.email || "").toLowerCase() === OLD_EMAIL);
  const targetUser = users.find((user) => String(user.email || "").toLowerCase() === NEW_EMAIL);
  if (!oldUser) {
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
  const updatedTaskCount = updatedTasks.filter((task, index) => task !== tasks[index]).length;

  await Promise.all([
    firestoreStore.writeStoreValue(firestore, STORE_COLLECTION, "users", updatedUsers),
    firestoreStore.writeStoreValue(firestore, STORE_COLLECTION, "tasks", updatedTasks),
  ]);

  console.log(`Updated Umesh login and ${updatedTaskCount} assigned task records.`);
}

main().catch((error) => {
  console.error("Umesh email migration failed:", error.message || error);
  process.exit(1);
});
