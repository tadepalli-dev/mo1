// Fixes the display order of the 9 standard daily salesman checklist tasks
// (the "Pending tasks" table on the Home dashboard, sorted by task.sequence
// — see getTaskSequenceValue in js/utils.js). Six of the nine titles were
// already seeded with the sequence the business wants; three were out of
// order. Matches by exact title + frequency === "daily" across every
// department/employee that has these tasks, so the fix applies uniformly
// for every salesman, not just one branch.
//
// Usage:
//   node scripts/fix-salesman-task-sequence.js            # writes the fix
//   node scripts/fix-salesman-task-sequence.js --dry-run  # only prints what it would do

const path = require("path");
const { DatabaseSync } = require("node:sqlite");

const DRY_RUN = process.argv.includes("--dry-run");
const DB_PATH = path.join(__dirname, "..", "data", "motrack.db");

// Only these three titles are wrong today; the rest of the 9-item checklist
// (Greet customer=1, Seat the customer=2, Serve water=3, Take input=5,
// Mood boards=8, Hardware selection=9) already matches the wanted order.
const SEQUENCE_FIXES = {
  "Designers to help in material selection.": 4,
  "Ask and serve tea,coffee etc.": 6,
  "Get tags and sell the stock.": 7,
};

function main() {
  const db = new DatabaseSync(DB_PATH);
  const getStore = db.prepare("SELECT value FROM kv_store WHERE key = ?");
  const setStore = db.prepare(
    `INSERT INTO kv_store (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  );

  const tasks = JSON.parse(getStore.get("tasks").value || "[]");

  let changed = 0;
  const updated = tasks.map((task) => {
    if (task.frequency !== "daily" || task.active === false) {
      return task;
    }
    const wantedSequence = SEQUENCE_FIXES[task.title];
    if (wantedSequence === undefined || task.sequence === wantedSequence) {
      return task;
    }
    changed++;
    return { ...task, sequence: wantedSequence };
  });

  console.log(`${changed} task row${changed === 1 ? "" : "s"} would be updated.`);

  if (DRY_RUN || changed === 0) {
    return;
  }

  setStore.run("tasks", JSON.stringify(updated), new Date().toISOString());
  console.log("Done.");
}

main();
