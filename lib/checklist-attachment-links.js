const crypto = require("crypto");

const CHECKLIST_ATTACHMENT_PREFIX = "checklist-attachments/";
const DEFAULT_APP_URL = "https://motrack-app-mo.vercel.app";

function isChecklistAttachmentPath(pathname) {
  return String(pathname || "").startsWith(CHECKLIST_ATTACHMENT_PREFIX);
}

function createAttachmentSignature(pathname, secret) {
  if (!secret || !isChecklistAttachmentPath(pathname)) {
    return "";
  }
  return crypto.createHmac("sha256", secret).update(String(pathname)).digest("base64url");
}

function buildChecklistAttachmentUrl(pathname, secret, appUrl = DEFAULT_APP_URL) {
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
  isChecklistAttachmentPath,
  buildChecklistAttachmentUrl,
  hasValidAttachmentSignature,
};
