const crypto = require("crypto");

const CHECKLIST_ATTACHMENT_PREFIX = "checklist-attachments/";
// Only the fallback. Attachment links are written into Google Sheets and
// outlive the request that made them, so a link built by the Firebase deploy
// must point at the Firebase host, not back at Vercel. APP_BASE_URL is read
// per call rather than at module load so a secret bound after cold start
// still takes effect.
const DEFAULT_APP_URL = "https://motrack-app-mo.vercel.app";

function defaultAppUrl() {
  return process.env.APP_BASE_URL || DEFAULT_APP_URL;
}

function isChecklistAttachmentPath(pathname) {
  return String(pathname || "").startsWith(CHECKLIST_ATTACHMENT_PREFIX);
}

function createAttachmentSignature(pathname, secret) {
  if (!secret || !isChecklistAttachmentPath(pathname)) {
    return "";
  }
  return crypto.createHmac("sha256", secret).update(String(pathname)).digest("base64url");
}

function buildChecklistAttachmentUrl(pathname, secret, appUrl = defaultAppUrl()) {
  const signature = createAttachmentSignature(pathname, secret);
  if (!signature) {
    return "";
  }
  const url = new URL("/api/checklist-attachment", appUrl);
  url.searchParams.set("pathname", pathname);
  url.searchParams.set("signature", signature);
  return url.toString();
}

function hasValidAttachmentSignature(pathname, signature, secret) {
  const expected = createAttachmentSignature(pathname, secret);
  if (!expected || !signature) {
    return false;
  }
  const expectedBuffer = Buffer.from(expected);
  const receivedBuffer = Buffer.from(String(signature));
  return expectedBuffer.length === receivedBuffer.length && crypto.timingSafeEqual(expectedBuffer, receivedBuffer);
}

module.exports = {
  CHECKLIST_ATTACHMENT_PREFIX,
  defaultAppUrl,
  isChecklistAttachmentPath,
  buildChecklistAttachmentUrl,
  hasValidAttachmentSignature,
};
