// Rebuilds the detailed submissions tab from the live Firestore store.
// This is safe to run repeatedly: the target tab is rewritten as one complete
// report, retaining every submitted record from 22 July 2026 onward.
const path = require("path");
const admin = require("firebase-admin");
const { getFirestore } = require("firebase-admin/firestore");
const firestoreStore = require("../lib/firestore-store");
const { rewriteSubmittedTaskDetailsSheet } = require("../lib/submitted-task-details-export");
const { buildChecklistAttachmentUrl } = require("../lib/checklist-attachment-links");

const ROOT = path.join(__dirname, "..");
const STORE_COLLECTION = "motrack_store";

async function main() {
  const serviceAccount = require(path.join(ROOT, "service-account-key.json"));
  admin.initializeApp({ credential: admin.cert(serviceAccount) });
  const firestore = getFirestore();
  const [tasks, completions, users] = await Promise.all(
    ["tasks", "completions", "users"].map((key) => firestoreStore.readStoreValue(firestore, STORE_COLLECTION, key, key === "completions" ? {} : []))
  );

  const result = await rewriteSubmittedTaskDetailsSheet(
    ROOT,
    { tasks, completions, users },
    {
      attachmentUrlBuilder: (attachmentPath) =>
        buildChecklistAttachmentUrl(attachmentPath, process.env.BLOB_READ_WRITE_TOKEN),
    }
  );
  console.log(`Wrote ${result.rowCount} detailed submission rows to ${result.sheetTitle}.`);
}

main().catch((error) => {
  console.error("Submitted-task-details resync failed:", error);
  process.exit(1);
});
