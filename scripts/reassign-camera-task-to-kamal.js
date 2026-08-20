// Reassigns the "All camera functioning weekly by Kamal." checklist task
// from Arun Mishra to Kamal himself — the task title already says the check
// is meant to be done "by Kamal", but it had been assigned to Arun Mishra.
// Keeps title/frequency/dates unchanged so the CAMERA FUNCTIONING CHECKLIST
// template match (js/data.js CHECKLIST_TEMPLATES, keyed by title) and
// completion behavior stay exactly the same — only the assignee changes.
// No prior completions exist for this task, so it's also safe to regenerate
// the taskId with Kamal's prefix, matching his other tasks (KAMA-xxxxxx).
//
// Usage:
//   node scripts/reassign-camera-task-to-kamal.js            # writes the change
//   node scripts/reassign-camera-task-to-kamal.js --dry-run  # only prints what it would do

const path = require("path");
const { DatabaseSync } = require("node:sqlite");

const DRY_RUN = process.argv.includes("--dry-run");
const DB_PATH = path.join(__dirname, "..", "data", "motrack.db");
const OLD_TASK_ID = "ARUN-773075";
const KAMAL_EMAIL = "kamal@modesigns.in";

function main() {
  const db = new DatabaseSync(DB_PATH);
  const getStore = db.prepare("SELECT value FROM kv_store WHERE key = ?");
  const setStore = db.prepare(
    `INSERT INTO kv_store (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  );

  const tasks = JSON.parse(getStore.get("tasks").value || "[]");
  const users = JSON.parse(getStore.get("users").value || "[]");
  const kamal = users.find((user) => user.email.toLowerCase() === KAMAL_EMAIL);
  if (!kamal) {
    console.error(`Could not find a user with email ${KAMAL_EMAIL}.`);
    process.exit(1);
  }

  const existingTaskIds = new Set(tasks.map((task) => String(task.taskId || task.id)));
  let newTaskId = `KAMA-${Date.now().toString().slice(-6)}`;
  while (existingTaskIds.has(newTaskId)) {
    newTaskId = `KAMA-${(Date.now() + 1).toString().slice(-6)}`;
  }

  let found = false;
  const updatedTasks = tasks.map((task) => {
    if (String(task.taskId || task.id) !== OLD_TASK_ID) {
      return task;
    }
    found = true;
    console.log(`Reassigning "${task.title}" (${OLD_TASK_ID} -> ${newTaskId}): ${task.assigneeName} -> ${kamal.name}`);
    return {
      ...task,
      id: newTaskId,
      taskId: newTaskId,
      department: kamal.designation && kamal.designation !== "-" ? kamal.designation : task.department,
      assigneeEmail: kamal.email,
      assigneeName: kamal.name,
      assigneeRole: kamal.role,
    };
  });

  if (!found) {
    console.log(`No task with id ${OLD_TASK_ID} found — nothing to do.`);
    return;
  }

  if (DRY_RUN) {
    console.log("\nDry run — nothing written.");
    return;
  }

  setStore.run("tasks", JSON.stringify(updatedTasks), new Date().toISOString());
  console.log("Done.");
}

main();
