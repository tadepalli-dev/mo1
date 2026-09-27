// Storage driver for checklist attachments.
//
// The app now deploys to two places: Vercel (which has Vercel Blob) and
// Firebase (which has Cloud Storage). Neither SDK exists on the other
// platform, so both are required lazily and the driver is picked at call
// time from whichever credential is present. Nothing here is imported at
// module load, so a Firebase deploy never has to ship @vercel/blob and a
// Vercel deploy never has to ship the Cloud Storage client.
//
// ATTACHMENT_STORE forces a driver ("vercel-blob" | "firebase-storage")
// when both credentials happen to be set, e.g. while testing the Firebase
// build locally against a .env that still carries the Vercel token.

const crypto = require("crypto");

function resolveDriver() {
  const forced = String(process.env.ATTACHMENT_STORE || "").trim();
  if (forced) {
    return forced;
  }
  return process.env.BLOB_READ_WRITE_TOKEN ? "vercel-blob" : "firebase-storage";
}

// The HMAC key behind the signed sheet links. It used to be the Vercel blob
// token purely because that was the one secret guaranteed to exist in
// production; on Firebase there is no such token, so a dedicated secret
// takes over. The old token stays as a fallback: switching the secret would
// otherwise invalidate every attachment link already written into the
// Google Sheets.
function attachmentSigningSecret() {
  return process.env.ATTACHMENT_SIGNING_SECRET || process.env.BLOB_READ_WRITE_TOKEN || "";
}

function firebaseBucket() {
  const admin = require("firebase-admin");
  const bucketName = process.env.FIREBASE_STORAGE_BUCKET || undefined;
  return admin.storage().bucket(bucketName);
}

// Vercel Blob's addRandomSuffix keeps two uploads of the same filename in the
// same second from overwriting each other. Cloud Storage has no equivalent,
// so the suffix is applied here before the key is used.
function withRandomSuffix(pathname) {
  const suffix = crypto.randomBytes(6).toString("hex");
  const dot = pathname.lastIndexOf(".");
  const slash = pathname.lastIndexOf("/");
  if (dot > slash && dot !== -1) {
    return `${pathname.slice(0, dot)}-${suffix}${pathname.slice(dot)}`;
  }
  return `${pathname}-${suffix}`;
}

// Returns { pathname, contentType } — the pathname is what gets stored on the
// completion record, so it must be the final key including any suffix.
async function putAttachment(pathname, buffer, options = {}) {
  const contentType = options.contentType || "application/octet-stream";

  if (resolveDriver() === "vercel-blob") {
    const { put } = require("@vercel/blob");
    const blob = await put(pathname, buffer, {
      access: "private",
      addRandomSuffix: options.addRandomSuffix !== false,
      contentType,
    });
    return { pathname: blob.pathname, contentType: blob.contentType || contentType };
  }

  const key = options.addRandomSuffix === false ? pathname : withRandomSuffix(pathname);
  await firebaseBucket().file(key).save(buffer, {
    contentType,
    // Attachments are only ever served back through /api/checklist-attachment,
    // which checks the session or the link signature first. Resumable uploads
    // are pointless for files capped at 3 MB and cost an extra round trip.
    resumable: false,
    metadata: { cacheControl: "private, no-store" },
  });
  return { pathname: key, contentType };
}

// Returns { contentType, stream } as a Node readable, or null when the object
// is not there. Callers pipe the stream straight to the response.
async function getAttachment(pathname) {
  if (resolveDriver() === "vercel-blob") {
    const { get } = require("@vercel/blob");
    const { Readable } = require("node:stream");
    const result = await get(pathname, { access: "private" });
    if (!result || result.statusCode !== 200 || !result.stream) {
      return null;
    }
    return {
      contentType: (result.blob && result.blob.contentType) || "application/octet-stream",
      stream: Readable.fromWeb(result.stream),
    };
  }

  const file = firebaseBucket().file(pathname);
  const [exists] = await file.exists();
  if (!exists) {
    return null;
  }
  const [metadata] = await file.getMetadata();
  return {
    contentType: metadata.contentType || "application/octet-stream",
    stream: file.createReadStream(),
  };
}

module.exports = {
  resolveDriver,
  attachmentSigningSecret,
  putAttachment,
  getAttachment,
};
