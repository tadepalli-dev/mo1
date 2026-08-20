// Fixes two data gaps found in the 9-item daily salesman checklist while
// verifying the sequence fix applied by fix-salesman-task-sequence.js:
//
// 1. Three tasks had a typo'd title (extra space / extra period) that the
//    earlier exact-string sequence fix didn't match, so they kept their old
//    (now wrong) sequence number and collided with another task's sequence:
//      - ANOWER ALI:   "Designers  to help in material selection." (seq 7 -> 4)
//      - PRADEEP:      "Ask and serve tea,coffee etc.." (seq 4 -> 6)
//      - TAPESHWAR:    "Ask and serve tea,coffee etc.." (seq 4 -> 6)
//    This pass matches by keyword instead of exact title so typo'd rows are
//    still found.
//
// 2. Sweta was missing two whole tasks (Greet customer, Hardware selection)
//    that every other salesman has — not a sequence problem, the rows never
//    existed. Adds them using her existing tasks' plannedDate/validUntil so
//    they behave like the rest of her checklist.
//
// Usage:
//   node scripts/fix-salesman-checklist-gaps.js            # writes the fix
//   node scripts/fix-salesman-checklist-gaps.js --dry-run  # only prints what it would do

const path = require("path");
const { DatabaseSync } = require("node:sqlite");

const DRY_RUN = process.argv.includes("--dry-run");
const DB_PATH = path.join(__dirname, "..", "data", "motrack.db");

const KEYWORDS = [
  { sequence: 1, re: /greet/i },
  { sequence: 2, re: /seat the customer/i },
  { sequence: 3, re: /serve water/i },
  { sequence: 4, re: /designers?\s*to help/i },
  { sequence: 5, re: /take input of customer/i },
  { sequence: 6, re: /ask and serve tea/i },
  { sequence: 7, re: /get tags and sell/i },
  { sequence: 8, re: /mood ?boards? and sti?ching|then moodboards/i },
  { sequence: 9, re: /hardware selection/i },
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

  const tasks = JSON.parse(getStore.get("tasks").value || "[]");
  const users = JSON.parse(getStore.get("users").value || "[]");
  const salesmen = users.filter((user) => (user.role || "").toLowerCase() === "salesman");

  let sequenceFixCount = 0;
  const updatedTasks = tasks.map((task) => {
    if (task.frequency !== "daily" || task.active === false) {
      return task;
    }
    const match = KEYWORDS.find((keyword) => keyword.re.test(task.title));
    if (!match || task.sequence === match.sequence) {
      return task;
    }
    sequenceFixCount++;
    console.log(`Sequence fix: "${task.title}" (${task.taskId || task.id}) ${task.sequence} -> ${match.sequence}`);
    return { ...task, sequence: match.sequence };
  });

  const existingTaskIds = new Set(tasks.map((task) => String(task.taskId || task.id)));
  const newTasks = [];

  salesmen.forEach((user) => {
    const mine = updatedTasks.filter(
      (task) =>
        task.frequency === "daily" &&
        task.active !== false &&
        (task.assigneeEmail || "").toLowerCase() === user.email.toLowerCase()
    );
    const matchedSequences = new Set(
      mine.map((task) => KEYWORDS.find((keyword) => keyword.re.test(task.title))?.sequence).filter(Boolean)
    );
    const missing = KEYWORDS.filter((keyword) => !matchedSequences.has(keyword.sequence));
    if (!missing.length) {
      return;
    }

    const template = mine[0];
    if (!template) {
      console.log(`Skipping ${user.name} (${user.email}) — has no existing daily tasks to copy field values from.`);
      return;
    }

    missing.forEach((keyword, index) => {
      const title = STANDARD_TITLES[keyword.sequence];
      let taskId = createTaskCode(user.name, newTasks.length + index);
      while (existingTaskIds.has(taskId)) {
        taskId = createTaskCode(user.name, newTasks.length + index + 1000);
      }
      existingTaskIds.add(taskId);
      newTasks.push({
        id: taskId,
        taskId,
        title,
        frequency: "daily",
        department: template.department,
        plannedDate: template.plannedDate,
        validUntil: template.validUntil,
        details: title,
        createdAt: new Date().toISOString(),
        assigneeEmail: user.email,
        assigneeName: user.name,
        assigneeRole: user.role,
        assignedByEmail: template.assignedByEmail,
        assignedByName: template.assignedByName,
        active: true,
        sequence: keyword.sequence,
      });
      console.log(`New task: "${title}" for ${user.name} (${user.email}), sequence ${keyword.sequence}, id ${taskId}`);
    });
  });

  console.log(`\n${sequenceFixCount} sequence fix(es), ${newTasks.length} new task(s).`);

  if (DRY_RUN || (sequenceFixCount === 0 && newTasks.length === 0)) {
    return;
  }

  const finalTasks = [...updatedTasks, ...newTasks];
  setStore.run("tasks", JSON.stringify(finalTasks), new Date().toISOString());
  console.log("Done.");
}

const STANDARD_TITLES = {
  1: "Greet customer",
  2: "Seat the customer if other than carpet.",
  3: "Serve water both room temperature and cold.",
  4: "Designers to help in material selection.",
  5: "Take input of customer requirement by google form on T.V.",
  6: "Ask and serve tea,coffee etc.",
  7: "Get tags and sell the stock.",
  8: "Mood boards and stiching by designer-floor manager.",
  9: "Hardware selection by floor manager.",
};

main();
