// Minimal Firestore REST client for Apps Script. Apps Script has no native
// Firestore SDK (unlike Node's firebase-admin), so this signs a service
// account JWT by hand (Utilities.computeRsaSha256Signature — the same
// approach the well-known "OAuth2 for Apps Script" library uses internally)
// and talks to the Firestore REST API directly via UrlFetchApp.
//
// One-time setup, before any of this works:
//   1. Open your service-account-key.json (the same one the old Node sync
//      script used).
//   2. In the Apps Script editor: Project Settings (gear icon) -> Script
//      Properties -> Add script property, three times:
//        FIRESTORE_PROJECT_ID    -> the "project_id" field
//        FIRESTORE_CLIENT_EMAIL  -> the "client_email" field
//        FIRESTORE_PRIVATE_KEY   -> the "private_key" field, pasted exactly
//                                   as-is (including the literal \n's and
//                                   the BEGIN/END PRIVATE KEY lines)
//   Nothing secret is hardcoded in this file — it's all read from Script
//   Properties at runtime.

const FIRESTORE_TOKEN_CACHE_KEY_ = "firestore_access_token";

function getServiceAccountProps_() {
  const props = PropertiesService.getScriptProperties();
  const projectId = props.getProperty("FIRESTORE_PROJECT_ID");
  const clientEmail = props.getProperty("FIRESTORE_CLIENT_EMAIL");
  const privateKey = props.getProperty("FIRESTORE_PRIVATE_KEY");
  if (!projectId || !clientEmail || !privateKey) {
    throw new Error(
      "Missing FIRESTORE_PROJECT_ID / FIRESTORE_CLIENT_EMAIL / FIRESTORE_PRIVATE_KEY " +
        "script properties. Set them under Project Settings -> Script Properties."
    );
  }
  return { projectId: projectId, clientEmail: clientEmail, privateKey: privateKey };
}

function base64UrlEncode_(bytesOrString) {
  const bytes = typeof bytesOrString === "string" ? Utilities.newBlob(bytesOrString).getBytes() : bytesOrString;
  return Utilities.base64EncodeWebSafe(bytes).replace(/=+$/, "");
}

// Access tokens are valid for an hour; cached for 50 minutes so a sync that
// runs every few minutes doesn't re-sign a JWT and hit Google's token
// endpoint every single time.
function getFirestoreAccessToken_() {
  const cache = CacheService.getScriptCache();
  const cached = cache.get(FIRESTORE_TOKEN_CACHE_KEY_);
  if (cached) {
    return cached;
  }

  const account = getServiceAccountProps_();
  const nowSeconds = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const claims = {
    iss: account.clientEmail,
    scope: "https://www.googleapis.com/auth/datastore",
    aud: "https://oauth2.googleapis.com/token",
    iat: nowSeconds,
    exp: nowSeconds + 3600,
  };

  const unsigned = base64UrlEncode_(JSON.stringify(header)) + "." + base64UrlEncode_(JSON.stringify(claims));
  const signatureBytes = Utilities.computeRsaSha256Signature(unsigned, account.privateKey);
  const jwt = unsigned + "." + base64UrlEncode_(signatureBytes);

  const response = UrlFetchApp.fetch("https://oauth2.googleapis.com/token", {
    method: "post",
    contentType: "application/x-www-form-urlencoded",
    payload: {
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    },
    muteHttpExceptions: true,
  });

  const data = JSON.parse(response.getContentText());
  if (response.getResponseCode() !== 200 || !data.access_token) {
    throw new Error("Could not get a Firestore access token: " + response.getContentText());
  }

  cache.put(FIRESTORE_TOKEN_CACHE_KEY_, data.access_token, 50 * 60);
  return data.access_token;
}

// Converts one Firestore REST "fields" map (the {stringValue:...}/{mapValue:
// {fields:{...}}} wrapper format) into a plain JS object, so calling code
// can read data.salesPerson, data.dealSnapshot.title, etc. exactly like
// firebase-admin's doc.data() in the old Node script.
function firestoreFieldsToJs_(fields) {
  const result = {};
  Object.keys(fields || {}).forEach((key) => {
    result[key] = firestoreValueToJs_(fields[key]);
  });
  return result;
}

function firestoreValueToJs_(value) {
  if (!value) return null;
  if ("stringValue" in value) return value.stringValue;
  if ("integerValue" in value) return Number(value.integerValue);
  if ("doubleValue" in value) return value.doubleValue;
  if ("booleanValue" in value) return value.booleanValue;
  if ("timestampValue" in value) return value.timestampValue;
  if ("nullValue" in value) return null;
  if ("mapValue" in value) return firestoreFieldsToJs_((value.mapValue && value.mapValue.fields) || {});
  if ("arrayValue" in value) return ((value.arrayValue && value.arrayValue.values) || []).map(firestoreValueToJs_);
  return null;
}

// Runs a structuredQuery with one or more range/equality filters on a single
// collection and returns an array of { id, data } objects (data already
// converted to plain JS via firestoreFieldsToJs_). fieldFilters is an array
// of { field, op, value } where op is a Firestore REST operator string
// (e.g. "GREATER_THAN_OR_EQUAL", "LESS_THAN", "EQUAL") and value is a plain
// JS string/number — this wraps it as a stringValue/doubleValue for you.
function queryFirestoreCollection_(collectionId, fieldFilters, limit) {
  const account = getServiceAccountProps_();
  const token = getFirestoreAccessToken_();

  const filters = fieldFilters.map((f) => ({
    fieldFilter: {
      field: { fieldPath: f.field },
      op: f.op,
      value: typeof f.value === "number" ? { doubleValue: f.value } : { stringValue: f.value },
    },
  }));

  const structuredQuery = {
    from: [{ collectionId: collectionId }],
    limit: limit || 2000,
  };
  if (filters.length === 1) {
    structuredQuery.where = filters[0];
  } else if (filters.length > 1) {
    structuredQuery.where = { compositeFilter: { op: "AND", filters: filters } };
  }

  const url =
    "https://firestore.googleapis.com/v1/projects/" + account.projectId + "/databases/(default)/documents:runQuery";
  const response = UrlFetchApp.fetch(url, {
    method: "post",
    contentType: "application/json",
    headers: { Authorization: "Bearer " + token },
    payload: JSON.stringify({ structuredQuery: structuredQuery }),
    muteHttpExceptions: true,
  });

  if (response.getResponseCode() !== 200) {
    throw new Error("Firestore query on " + collectionId + " failed: " + response.getContentText());
  }

  const rows = JSON.parse(response.getContentText());
  return rows
    .filter((row) => row.document)
    .map((row) => {
      const nameParts = row.document.name.split("/");
      return { id: nameParts[nameParts.length - 1], data: firestoreFieldsToJs_(row.document.fields) };
    });
}
