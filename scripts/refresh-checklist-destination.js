#!/usr/bin/env node

// Destination-owned scheduled pipeline.  It first performs the read-only
// pull from the main Firebase project, then exports the checklist project's
// resulting state to Google Sheets.  Neither step writes to the source app.

const path = require("path");
const { spawnSync } = require("node:child_process");

const ROOT = path.join(__dirname, "..");

function run(script, args = []) {
  const result = spawnSync(process.execPath, [path.join(ROOT, "scripts", script), ...args], {
    cwd: ROOT,
    stdio: "inherit",
    env: process.env,
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    process.exit(result.status || 1);
  }
}

run("sync-walkins.js");
run("sync-to-sheets.js", ["--from-firestore"]);
