// Pulls "Handed Over" walk-in customers from the Walk-in Desk Firestore
// project and creates a full copy of the standard sales checklist for each
// customer, assigned to the matching salesman (matched by normalized name).
// The existing generic recurring versions of these tasks are untouched —
// this only adds new, customer-specific ones alongside them.
//
// Safe to re-run — checks each of the 9 standard tasks individually, so a
// walk-in that already has some of them (e.g. from before the checklist was
// expanded) only gets the missing ones backfilled, never duplicated.
//
// Usage:
//   node scripts/sync-walkins.js            # writes new tasks
//   node scripts/sync-walkins.js --dry-run  # only prints what it would do

const path = require("path");
const { DatabaseSync } = require("node:sqlite");
const admin = require("firebase-admin");
const { getFirestore } = require("firebase-admin/firestore");

const DRY_RUN = process.argv.includes("--dry-run");
const DB_PATH = path.join(__dirname, "..", "data", "motrack.db");
const SERVICE_ACCOUNT_PATH = path.join(__dirname, "..", "service-account-key.json");

// The same 9 tasks already seeded as generic daily recurring tasks for every
// salesman — this is the standard per-customer sales-floor checklist.
//
// New items must always be appended at the end, never inserted earlier —
// each item's array index becomes part of its task ID (`<walkinId>-<index+1>`),
// so reordering silently reassigns already-written task IDs to a different
// checklist item instead of being detected as new/missing.
const STANDARD_TASK_TITLES = [
  "Ask and serve tea,coffee etc.",
  "Hardware selection by floor manger.",
  "Then moodboards and stiching.",
  "Designers to help in material selection.",
  "Get tags and sell the stock.",
  "Greet customers",
  "Seat the customer if other than carpet.",
  "Serve water both room temperature and cold.",
  "Take input of customer requirement by google form on T.V",
];

function normalizePersonName(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function todayValue() {
  const now = new Date();
  const offset = now.getTimezoneOffset() * 60000;
  return new Date(now - offset).toISOString().slice(0, 10);
}

// The CRM's `handedTo`/`handedOverAt` fields exist but are null in practice —
// `salesmanName`/`assignedAt` are what's actually populated when a walk-in is
// handed over, so that's the real handover date, not the day this script runs.
function resolveWalkinDate(data) {
  const raw = data.assignedAt || data.handedOverAt || data.createdAt;
  const sliced = String(raw || "").slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(sliced) ? sliced : todayValue();
}

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

  const users = JSON.parse(getStore.get("users").value);
  const tasks = JSON.parse(getStore.get("tasks").value || "[]");

  const salesmenByNormalizedName = new Map();
  users
    .filter((user) => user.role.toLowerCase() === "salesman")
    .forEach((user) => salesmenByNormalizedName.set(normalizePersonName(user.name), user));

  const existingTaskIds = new Set(tasks.map((task) => String(task.taskId || task.id)));

  // The CRM moves a walk-in through several statuses after handover (e.g.
  // "Handed Over" -> "Deal Created" -> ...), often within minutes, so
  // filtering on one exact status misses assignments that progress before a
  // sync cycle catches them. The real trigger is "a salesman was assigned"
  // (the HANDED TO column being filled in / salesmanName being set), which
  // stays true regardless of how far the deal has since progressed.
  // orderBy(assignedAt) also excludes docs where it was never set at all.
  //
  // Only today's handovers are synced — dashboards only ever display
  // walkinDate === today, so anything older would just be dead rows in the
  // store. Matching the same rule here avoids writing tasks that can never
  // be shown.
  const today = todayValue();

  const snapshot = await firestore
    .collection("Walkin_Customer")
    .orderBy("assignedAt", "desc")
    .limit(200)
    .get();

  const newTasks = [];
  const skippedExisting = [];
  const unmatched = [];
  const customersSynced = [];

  snapshot.forEach((doc) => {
    const data = doc.data();
    if (!data.salesmanName) {
      return;
    }
    if (resolveWalkinDate(data) !== today) {
      return;
    }

    const walkinId = data.walkinId || doc.id;
    const missingIndexes = STANDARD_TASK_TITLES.map((_, index) => index).filter(
      (index) => !existingTaskIds.has(`${walkinId}-${index + 1}`)
    );

    if (!missingIndexes.length) {
      skippedExisting.push(walkinId);
      return;
    }

    const salesman = salesmenByNormalizedName.get(normalizePersonName(data.salesmanName));
    if (!salesman) {
      unmatched.push({ walkinId, salesmanName: data.salesmanName });
      return;
    }

    const customerName = `${data.firstName || ""} ${data.familyName || ""}`.trim() || "this customer";
    const lookingFor = Array.isArray(data.lookingFor) ? data.lookingFor.join(", ") : "";
    const details = [data.mobile ? `Mobile: ${data.mobile}` : null, lookingFor ? `Looking for: ${lookingFor}` : null]
      .filter(Boolean)
      .join(" | ");
    const createdAt = new Date().toISOString();
    const walkinDate = resolveWalkinDate(data);

    missingIndexes.forEach((index) => {
      const standardTitle = STANDARD_TASK_TITLES[index];
      const taskId = `${walkinId}-${index + 1}`;
      newTasks.push({
        id: taskId,
        taskId,
        title: `${standardTitle} for ${customerName}`,
        checklistLabel: standardTitle,
        source: "walkin",
        walkinId,
        customerName,
        walkinDate,
        frequency: "one_time",
        department: data.storeName || data.store || "-",
        plannedDate: walkinDate,
        validUntil: walkinDate,
        details,
        createdAt,
        assigneeEmail: salesman.email,
        assigneeName: salesman.name,
        assigneeRole: salesman.role,
        assignedByEmail: "walkin-sync@modesigns.in",
        assignedByName: "Walk-in Sync",
        active: true,
      });
    });

    customersSynced.push({ walkinId, customerName, salesman: salesman.name });
  });

  const assignedCount = snapshot.docs.filter((doc) => doc.data().salesmanName).length;
  console.log(`Recent walk-ins checked: ${snapshot.size} | assigned to a salesman: ${assignedCount}`);
  console.log(`Already synced (skipped): ${skippedExisting.length}`, skippedExisting);
  console.log(`Unmatched salesman names: ${unmatched.length}`, unmatched);
  console.log(`Customers with new or missing tasks: ${customersSynced.length} (${newTasks.length} tasks total)`);
  customersSynced.forEach((c) => {
    console.log(`  - ${c.walkinId}: ${c.customerName} -> ${c.salesman}`);
  });

  if (DRY_RUN) {
    console.log("\nDry run — nothing written.");
    return;
  }

  if (!newTasks.length) {
    console.log("\nNothing to write.");
    return;
  }

  const updatedTasks = [...newTasks, ...tasks];
  setStore.run("tasks", JSON.stringify(updatedTasks), new Date().toISOString());
  console.log(`\nWrote ${newTasks.length} new task(s) to data/motrack.db.`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("Sync failed:", error);
    process.exit(1);
  });
