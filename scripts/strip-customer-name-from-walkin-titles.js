// Every walk-in task's title had the customer's name baked into it
// ("Ask and serve tea,coffee etc. for RAJNI"), duplicating the separate
// customerName field the same task already carries — visible wherever this
// data is displayed with its own customer column (the Tasks sheet export,
// the app's walk-in board). scripts/sync-walkins.js no longer does this for
// newly-created tasks; this is the one-off cleanup for the ~300 rows
// already written with the old behavior.
//
// Usage:
//   node scripts/strip-customer-name-from-walkin-titles.js            # writes the fix
//   node scripts/strip-customer-name-from-walkin-titles.js --dry-run  # only prints what it would do

const path = require("path");
const { DatabaseSync } = require("node:sqlite");

const DRY_RUN = process.argv.includes("--dry-run");
const DB_PATH = path.join(__dirname, "..", "data", "motrack.db");

function main() {
  const db = new DatabaseSync(DB_PATH);
  const getStore = db.prepare("SELECT value FROM kv_store WHERE key = ?");
  const setStore = db.prepare(
    `INSERT INTO kv_store (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  );

  const tasks = JSON.parse(getStore.get("tasks").value || "[]");
  let fixedCount = 0;
  const updated = tasks.map((task) => {
    if (task.source !== "walkin" || !task.checklistLabel || task.title === task.checklistLabel) {
      return task;
    }
    fixedCount++;
    return { ...task, title: task.checklistLabel };
  });

  console.log(`${fixedCount} walk-in task title(s) would be cleaned of their "for {customer}" suffix.`);

  if (DRY_RUN || !fixedCount) {
    console.log(DRY_RUN ? "\nDry run — nothing written." : "Nothing to do.");
    return;
  }

  setStore.run("tasks", JSON.stringify(updated), new Date().toISOString());
  console.log("Done.");
}

main();
