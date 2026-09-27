// Single source for the Google service account used to sign Sheets API JWTs.
//
// Five libs each grew their own copy of this loader, all reading
// service-account-key.json off disk. That file does not exist on Cloud
// Functions — the code is deployed from a repo that gitignores it — so on
// Firebase every Sheets call failed on the missing file before it ever
// reached Google. The key therefore comes from an environment variable
// there (Secret Manager), and from the file everywhere else.
//
// GOOGLE_SHEETS_SERVICE_ACCOUNT holds the whole key JSON. Some secret
// stores mangle embedded newlines in the PEM, so a \n-escaped private_key
// is repaired on the way out rather than failing later with an opaque
// "error:0909006C" from the signer.

const fs = require("fs");
const path = require("path");

const SERVICE_ACCOUNT_FILENAME = "service-account-key.json";
const ENV_VAR = "GOOGLE_SHEETS_SERVICE_ACCOUNT";
// The Firebase Admin credential. On Cloud Functions this is unnecessary
// (the runtime supplies it), but a plain container host such as Render has
// neither a key file nor ambient credentials, so it has to come from the
// environment there.
const FIREBASE_ENV_VAR = "FIREBASE_SERVICE_ACCOUNT";

function normalize(serviceAccount) {
  if (serviceAccount && typeof serviceAccount.private_key === "string") {
    serviceAccount.private_key = serviceAccount.private_key.replace(/\n/g, "\n");
  }
  return serviceAccount;
}

// Returns the parsed key, or null when neither source has one. Callers decide
// whether that is fatal — some features degrade, others must throw.
function readFromEnvOrFile(envVar, rootDir) {
  const raw = process.env[envVar];
  if (raw && raw.trim()) {
    try {
      return normalize(JSON.parse(raw));
    } catch (error) {
      throw new Error(`${envVar} is set but is not valid JSON: ${error.message}`);
    }
  }

  const keyPath = path.join(rootDir || process.cwd(), SERVICE_ACCOUNT_FILENAME);
  if (!fs.existsSync(keyPath)) {
    return null;
  }
  return normalize(JSON.parse(fs.readFileSync(keyPath, "utf8")));
}

// The Google Sheets signing key.
function readServiceAccount(rootDir) {
  return readFromEnvOrFile(ENV_VAR, rootDir);
}

// The Firebase Admin credential. Returns null when neither source has one,
// which the caller treats as "fall back to Application Default Credentials".
function readFirebaseServiceAccount(rootDir) {
  return readFromEnvOrFile(FIREBASE_ENV_VAR, rootDir);
}

// The path/env pair named in error messages, so a failure says where to look.
function serviceAccountSourceHint(rootDir) {
  return `${ENV_VAR} or ${path.join(rootDir || process.cwd(), SERVICE_ACCOUNT_FILENAME)}`;
}

module.exports = {
  SERVICE_ACCOUNT_FILENAME,
  ENV_VAR,
  FIREBASE_ENV_VAR,
  readServiceAccount,
  readFirebaseServiceAccount,
  serviceAccountSourceHint,
};
