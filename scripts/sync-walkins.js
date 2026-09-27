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

const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");
const admin = require("firebase-admin");
const { getFirestore } = require("firebase-admin/firestore");

const firestoreStore = require("../lib/firestore-store");

const DRY_RUN = process.argv.includes("--dry-run");
const DB_PATH = path.join(__dirname, "..", "data", "motrack.db");
// The checked-in local key is for the main walk-in project.  It is used only
// to read assignments during a local run.  Production supplies this same
// credential through SOURCE_FIREBASE_SERVICE_ACCOUNT instead.
const SOURCE_SERVICE_ACCOUNT_PATH = path.join(__dirname, "..", "service-account-key.json");
const SOURCE_SERVICE_ACCOUNT_ENV = "SOURCE_FIREBASE_SERVICE_ACCOUNT";
// Never fall back to the source key for this one: doing so would write the
// checklist state back into the main Firebase project.
const DESTINATION_SERVICE_ACCOUNT_ENVS = [
  "CHECKLIST_FIREBASE_SERVICE_ACCOUNT",
  "FIREBASE_SERVICE_ACCOUNT",
];
// The hosted app (api/index.js) reads and writes its state here. This script
// used to write only to the local SQLite file, which the deployed app can
// only see through a fresh git commit + redeploy — so walk-ins handed over
// after the last deploy never got a Customer/Deal ID in the hosted
// dashboard, while localhost showed them fine.
const FIRESTORE_STORE_COLLECTION = "motrack_store";

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

function parseServiceAccount(raw, variableName) {
  try {
    const account = JSON.parse(raw);
    if (!account.project_id || !account.client_email || !account.private_key) {
      throw new Error("missing project_id, client_email, or private_key");
    }
    return account;
  } catch (error) {
    throw new Error(`${variableName} must contain a complete Firebase service-account JSON value: ${error.message}`);
  }
}

function readSourceServiceAccount() {
  const fromEnvironment = String(process.env[SOURCE_SERVICE_ACCOUNT_ENV] || "").trim();
  if (fromEnvironment) {
    return parseServiceAccount(fromEnvironment, SOURCE_SERVICE_ACCOUNT_ENV);
  }
  if (!fs.existsSync(SOURCE_SERVICE_ACCOUNT_PATH)) {
    throw new Error(
      `Missing ${SOURCE_SERVICE_ACCOUNT_ENV}. For a local run, place the read-only main-project key at ${SOURCE_SERVICE_ACCOUNT_PATH}.`
    );
  }
  return require(SOURCE_SERVICE_ACCOUNT_PATH);
}

function readDestinationServiceAccount() {
  for (const variableName of DESTINATION_SERVICE_ACCOUNT_ENVS) {
    const raw = String(process.env[variableName] || "").trim();
    if (raw) {
      return parseServiceAccount(raw, variableName);
    }
  }
  throw new Error(
    `Missing ${DESTINATION_SERVICE_ACCOUNT_ENVS.join(" or ")}. ` +
      "This must be the service-account key for the chacklist-dashbords project, never the main Firebase project."
  );
}

// The CRM's `handedTo`/`handedOverAt` fields exist but are null in practice —
// `salesmanName`/`assignedAt` are what's actually populated when a walk-in is
// handed over, so that's the real handover date, not the day this script runs.
function resolveWalkinDate(data) {
  const raw = data.assignedAt || data.handedOverAt || data.createdAt;
  const sliced = String(raw || "").slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(sliced) ? sliced : todayValue();
}

function isActiveSalesman(user) {
  return (
    String(user?.role || "").trim().toLowerCase() === "salesman" &&
    (user?.isActive === true || String(user?.isActive).trim().toLowerCase() === "true")
  );
}

function toChecklistSalesman(doc) {
  const user = doc.data() || {};
  // Only operational identity fields are copied. Passwords and private HR
  // information stay exclusively in the main Firebase project.
  return {
    source: "motrack-user-sync",
    sourceUserId: doc.id,
    name: String(user.name || "").trim(),
    email: String(user.email || "").trim().toLowerCase(),
    role: "salesman",
    active: true,
    isActive: true,
    employeeCode: String(user.employeeCode || "").trim(),
    salesmanCode: String(user.salesmanCode || "").trim(),
    designation: String(user.designation || "").trim(),
    department: String(user.department || "").trim(),
    dayOff: String(user.weekOff || user.dayOff || "").trim(),
    syncedAt: new Date().toISOString(),
  };
}

async function readActiveSalesmen(sourceFirestore) {
  // Read-only access to the main Firebase app. This script never sends any
  // write through sourceFirestore.
  const snapshot = await sourceFirestore.collection("users").where("role", "==", "salesman").get();
  return snapshot.docs
    .filter((doc) => isActiveSalesman(doc.data()))
    .map(toChecklistSalesman)
    .filter((user) => user.name && user.email);
}

function mergeSalesmenIntoChecklistUsers(existingUsers, sourceSalesmen) {
  const next = Array.isArray(existingUsers) ? existingUsers.map((user) => ({ ...user })) : [];
  const indexByEmail = new Map(
    next.map((user, index) => [String(user.email || "").trim().toLowerCase(), index]).filter(([email]) => email)
  );
  const sourceEmails = new Set(sourceSalesmen.map((user) => user.email));

  sourceSalesmen.forEach((sourceUser) => {
    const index = indexByEmail.get(sourceUser.email);
    if (index === undefined) {
      next.push(sourceUser);
      indexByEmail.set(sourceUser.email, next.length - 1);
      return;
    }
    const existing = next[index];
    const password = existing.password;
    next[index] = { ...existing, ...sourceUser };
    // A checklist-only password is preserved; no password is read from the
    // main Firebase app.
    if (password !== undefined) {
      next[index].password = password;
    }
  });

  // Keep historical task owners, but disable salesmen who have since become
  // inactive in the main user list.
  next.forEach((user) => {
    if (user.source === "motrack-user-sync" && !sourceEmails.has(String(user.email || "").toLowerCase())) {
      user.active = false;
      user.isActive = false;
      user.deactivatedAt = new Date().toISOString();
    }
  });

  return next;
}

async function main() {
  // Separate named Admin apps make the data direction explicit:
  // main Firebase (source) is queried only; checklist-dashboard (destination)
  // receives every write.
  const sourceApp = admin.initializeApp(
    { credential: admin.cert(readSourceServiceAccount()) },
    "walkin-source"
  );
  const destinationApp = admin.initializeApp(
    { credential: admin.cert(readDestinationServiceAccount()) },
    "checklist-destination"
  );
  const sourceFirestore = getFirestore(sourceApp);
  const destinationFirestore = getFirestore(destinationApp);

  const db = new DatabaseSync(DB_PATH);
  const getStore = db.prepare("SELECT value FROM kv_store WHERE key = ?");
  const setStore = db.prepare(
    `INSERT INTO kv_store (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  );

  // Firestore is the hosted app's source of truth, so it — not the local
  // SQLite copy — is the base to append onto. Reading SQLite instead would
  // clobber anything created through the hosted dashboard since the last
  // deploy the moment this script wrote back.
  const missingFromFirestore = new Set();
  const readStore = async (key, fallbackValue) => {
    const local = getStore.get(key);
    const localValue = local ? JSON.parse(local.value || "null") : null;
    try {
      const remote = await firestoreStore.readStoreValue(
        destinationFirestore,
        FIRESTORE_STORE_COLLECTION,
        key,
        null
      );
      if (remote !== null) {
        return remote;
      }
      missingFromFirestore.add(key);
    } catch (error) {
      console.warn(`Firestore read failed for "${key}", using local SQLite copy.`, error.message);
    }
    return localValue ?? fallbackValue;
  };

  const existingUsers = await readStore("users", []);
  const tasks = await readStore("tasks", []);
  const sourceSalesmen = await readActiveSalesmen(sourceFirestore);
  const users = mergeSalesmenIntoChecklistUsers(existingUsers, sourceSalesmen);
  const rosterChanged = JSON.stringify(users) !== JSON.stringify(existingUsers);

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

  const snapshot = await sourceFirestore
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
        // customerName already gets its own column/field wherever this is
        // displayed (the app's walk-in board, the Tasks sheet export) — a
        // "for {customer}" suffix on the title just repeats it.
        title: standardTitle,
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
  console.log(`Active salesmen copied from main Firebase: ${sourceSalesmen.length}`);
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

  // A quiet day still has to seed Firestore the first time, otherwise the
  // hosted app keeps reading the SQLite snapshot frozen at the last deploy
  // and no walk-in ever gets a Customer/Deal ID there.
  const needsFirestoreSeed = missingFromFirestore.has("tasks");
  if (!newTasks.length && !needsFirestoreSeed && !rosterChanged) {
    console.log("\nNothing to write.");
    return;
  }
  if (needsFirestoreSeed) {
    console.log(`\n"tasks" is not in Firestore yet — seeding it with all ${tasks.length} local task(s).`);
  }

  const updatedTasks = [...newTasks, ...tasks];

  // Firestore first: it's what the hosted dashboard actually reads, so a
  // failure here has to be loud (non-zero exit) instead of leaving the local
  // file ahead of production again.
  const result = await firestoreStore.writeStoreValue(
    destinationFirestore,
    FIRESTORE_STORE_COLLECTION,
    "tasks",
    updatedTasks
  );
  console.log(
    `\nWrote ${newTasks.length} new task(s) to Firestore (${(result.bytes / 1024).toFixed(0)} KB` +
      `${result.chunkCount ? `, ${result.chunkCount} chunks` : ""}).`
  );

  setStore.run("tasks", JSON.stringify(updatedTasks), new Date().toISOString());
  console.log(`Mirrored the same ${updatedTasks.length} task(s) to data/motrack.db.`);

  // Tasks are matched to a salesman by assigneeEmail, so the hosted app needs
  // the same roster this script matched against. Seeded only when absent —
  // once Firestore holds it, the hosted dashboard owns it.
  if (missingFromFirestore.has("users") || rosterChanged) {
    await firestoreStore.writeStoreValue(destinationFirestore, FIRESTORE_STORE_COLLECTION, "users", users);
    console.log(`Synced ${users.length} checklist user record(s) to Firestore.`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("Sync failed:", error);
    process.exit(1);
  });
