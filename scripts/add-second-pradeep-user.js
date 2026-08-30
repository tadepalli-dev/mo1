// pradeepparsipur@gmail.com and modesignspradeep@gmail.com turned out to be
// TWO DIFFERENT real employees who happen to share the same CRM salesman
// code ("CP") and designation ("salesmanager") — confirmed directly by the
// admin, after an earlier fix wrongly assumed they were the same person and
// linked them as one login (aliasEmails). This script undoes that alias and
// creates modesignspradeep@gmail.com as its own separate salesman account,
// seeded with the same standard 9-item daily checklist every other salesman
// has (see scripts/fix-salesman-checklist-gaps.js for that list's origin).
//
// Updates the local dev DB only — production Firestore has no 'users'/
// 'tasks' documents (confirmed separately), so this repo's data/motrack.db
// is what actually gets deployed as the production fallback snapshot; a
// `vercel --prod` redeploy after running this is what ships it live.
//
// Usage:
//   node scripts/add-second-pradeep-user.js            # writes the change
//   node scripts/add-second-pradeep-user.js --dry-run  # only prints what it would do

const path = require("path");
const { DatabaseSync } = require("node:sqlite");

const DRY_RUN = process.argv.includes("--dry-run");
const DB_PATH = path.join(__dirname, "..", "data", "motrack.db");

const OLD_PRADEEP_EMAIL = "pradeepparsipur@gmail.com";
const NEW_EMAIL = "modesignspradeep@gmail.com";

const NEW_USER = {
  name: "PRADEEP",
  email: NEW_EMAIL,
  role: "salesman",
  designation: "salesmanager",
  code: "CP",
  dayOff: "Tuesday",
  password: "Pradeep1042@",
};

const STANDARD_TITLES = [
  "Greet customer",
  "Seat the customer if other than carpet.",
  "Serve water both room temperature and cold.",
  "Designers to help in material selection.",
  "Take input of customer requirement by google form on T.V.",
  "Ask and serve tea,coffee etc.",
  "Get tags and sell the stock.",
  "Mood boards and stiching by designer-floor manager.",
  "Hardware selection by floor manager.",
];

function createTaskCode(name, salt) {
  const base = name.replace(/[^a-z0-9]/gi, "").toUpperCase().slice(0, 4) || "TASK";
  const stamp = (Date.now() + salt).toString().slice(-6);
  return `${base}-${stamp}`;
}

function main() {
  const db = new DatabaseSync(DB_PATH);
  const getStore = db.prepare("SELECT value FROM kv_store WHERE key = ?");
  const setStore = db.prepare(
    `INSERT INTO kv_store (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  );

  let users = JSON.parse(getStore.get("users").value || "[]");
  const tasks = JSON.parse(getStore.get("tasks").value || "[]");

  const oldPradeep = users.find((user) => String(user.email || "").toLowerCase() === OLD_PRADEEP_EMAIL);
  if (oldPradeep && Array.isArray(oldPradeep.aliasEmails)) {
    const hadAlias = oldPradeep.aliasEmails.some((alias) => String(alias).toLowerCase() === NEW_EMAIL);
    if (hadAlias) {
      console.log(`Removing wrongly-added alias "${NEW_EMAIL}" from ${oldPradeep.name} (${oldPradeep.email}).`);
      users = users.map((user) =>
        user === oldPradeep
          ? { ...user, aliasEmails: user.aliasEmails.filter((alias) => String(alias).toLowerCase() !== NEW_EMAIL) }
          : user
      );
      const stillHasAliases = users.find((u) => u.email === oldPradeep.email).aliasEmails.length > 0;
      if (!stillHasAliases) {
        users = users.map((user) => {
          if (user.email !== oldPradeep.email) return user;
          const { aliasEmails, ...rest } = user;
          return rest;
        });
      }
    }
  }

  const alreadyExists = users.some((user) => String(user.email || "").toLowerCase() === NEW_EMAIL);
  if (alreadyExists) {
    console.log(`A user with email ${NEW_EMAIL} already exists — not creating a duplicate.`);
  } else {
    console.log(`Creating new user: ${NEW_USER.name} <${NEW_USER.email}>, role ${NEW_USER.role}.`);
    users = [NEW_USER, ...users];
  }

  const existingTaskIds = new Set(tasks.map((task) => String(task.taskId || task.id)));
  const newTasks = [];
  const alreadyHasTasks = tasks.some((task) => (task.assigneeEmail || "").toLowerCase() === NEW_EMAIL);
  if (alreadyHasTasks) {
    console.log(`${NEW_EMAIL} already has task rows — not adding the standard checklist again.`);
  } else {
    STANDARD_TITLES.forEach((title, index) => {
      let taskId = createTaskCode(NEW_USER.name, newTasks.length);
      while (existingTaskIds.has(taskId)) {
        taskId = createTaskCode(NEW_USER.name, newTasks.length + 1000);
      }
      existingTaskIds.add(taskId);
      newTasks.push({
        id: taskId,
        taskId,
        title,
        frequency: "daily",
        department: "salesman",
        plannedDate: "2026-08-20",
        validUntil: "2027-08-02",
        details: title,
        createdAt: new Date().toISOString(),
        assigneeEmail: NEW_USER.email,
        assigneeName: NEW_USER.name,
        assigneeRole: NEW_USER.role,
        assignedByEmail: "asha@modesigns.in",
        assignedByName: "Asha",
        active: true,
        sequence: index + 1,
      });
    });
    console.log(`Adding ${newTasks.length} standard daily checklist tasks for ${NEW_USER.name}.`);
  }

  if (DRY_RUN) {
    console.log("\nDry run — nothing written.");
    return;
  }

  setStore.run("users", JSON.stringify(users), new Date().toISOString());
  if (newTasks.length) {
    setStore.run("tasks", JSON.stringify([...newTasks, ...tasks]), new Date().toISOString());
  }
  console.log("Done.");
}

main();
