// Firestore-backed key/value store for the MoTrack app state.
//
// Firestore caps a single document at ~1 MB. The "tasks" key blew past that
// (2 MB and growing — one walk-in adds 9 task objects), so every write to it
// failed, the document was never created, and production silently fell back
// to the read-only SQLite snapshot bundled at deploy time. That's why walk-in
// customers synced after a deploy never showed a Customer/Deal ID in the
// hosted dashboard while localhost — which reads the live SQLite file — was
// always correct.
//
// Oversized values are therefore split across sibling chunk documents:
//
//   motrack_store/tasks            -> { chunkCount: 4, updated_at }
//   motrack_store/tasks__chunk_0   -> { value: "<slice 0>" }
//   ...
//
// Small values keep the original single-document shape ({ value, updated_at })
// so the keys already stored that way (absences, completions) keep working
// with no migration.

// Firestore's hard limit is 1 MiB per document, counting field names, index
// entries and overhead. 700 KB of payload leaves comfortable headroom.
const MAX_CHUNK_BYTES = 700 * 1024;
const CHUNK_SUFFIX = "__chunk_";
// Chunk documents are only ever written alongside a manifest, so a stale run
// can never leave more than this many orphans behind to clean up.
const MAX_CHUNKS = 64;

function chunkDocId(key, index) {
  return `${key}${CHUNK_SUFFIX}${index}`;
}

// Splits a UTF-8 buffer into slices of at most maxBytes, never cutting a
// multi-byte character in half — a continuation byte is 0b10xxxxxx, so walk
// the boundary backwards until it lands on a leading byte.
function splitUtf8(buffer, maxBytes) {
  const slices = [];
  let start = 0;

  while (start < buffer.length) {
    let end = Math.min(start + maxBytes, buffer.length);
    while (end > start + 1 && end < buffer.length && (buffer[end] & 0xc0) === 0x80) {
      end -= 1;
    }
    slices.push(buffer.subarray(start, end).toString("utf8"));
    start = end;
  }

  return slices;
}

// Returns the raw JSON string for a key, or null when the key has never been
// written to Firestore (the caller then falls back to SQLite).
async function readStoreJson(firestore, collection, key) {
  const snapshot = await firestore.collection(collection).doc(key).get();
  if (!snapshot.exists) {
    return null;
  }

  const data = snapshot.data() || {};
  if (typeof data.value === "string") {
    return data.value;
  }

  const chunkCount = Number(data.chunkCount) || 0;
  if (!chunkCount) {
    return null;
  }

  const refs = [];
  for (let index = 0; index < chunkCount; index++) {
    refs.push(firestore.collection(collection).doc(chunkDocId(key, index)));
  }

  const chunkSnapshots = await firestore.getAll(...refs);
  const parts = chunkSnapshots.map((chunk, index) => {
    const chunkValue = chunk.exists ? chunk.data().value : null;
    if (typeof chunkValue !== "string") {
      throw new Error(`Missing chunk ${index} of ${chunkCount} for store key "${key}"`);
    }
    return chunkValue;
  });

  return parts.join("");
}

async function readStoreValue(firestore, collection, key, fallback) {
  const json = await readStoreJson(firestore, collection, key);
  if (json === null) {
    return fallback;
  }
  const parsed = JSON.parse(json);
  return parsed ?? fallback;
}

async function writeStoreValue(firestore, collection, key, value) {
  const json = JSON.stringify(value);
  const buffer = Buffer.from(json, "utf8");
  const updatedAt = new Date().toISOString();
  const docRef = firestore.collection(collection).doc(key);

  if (buffer.length <= MAX_CHUNK_BYTES) {
    const batch = firestore.batch();
    batch.set(docRef, { value: json, updated_at: updatedAt });
    // Drop chunks left over from a previous oversized write, otherwise a
    // later reader could stitch together a stale document.
    for (let index = 0; index < MAX_CHUNKS; index++) {
      batch.delete(firestore.collection(collection).doc(chunkDocId(key, index)));
    }
    await batch.commit();
    return { chunkCount: 0, bytes: buffer.length };
  }

  const slices = splitUtf8(buffer, MAX_CHUNK_BYTES);
  if (slices.length > MAX_CHUNKS) {
    throw new Error(
      `Store key "${key}" needs ${slices.length} chunks, above the ${MAX_CHUNKS} limit`
    );
  }

  const batch = firestore.batch();
  slices.forEach((slice, index) => {
    batch.set(firestore.collection(collection).doc(chunkDocId(key, index)), { value: slice });
  });
  // The manifest is written in the same batch as its chunks, so a reader
  // never sees a chunkCount pointing at documents that aren't there yet.
  batch.set(docRef, { chunkCount: slices.length, updated_at: updatedAt });
  for (let index = slices.length; index < MAX_CHUNKS; index++) {
    batch.delete(firestore.collection(collection).doc(chunkDocId(key, index)));
  }
  await batch.commit();

  return { chunkCount: slices.length, bytes: buffer.length };
}

module.exports = {
  MAX_CHUNK_BYTES,
  readStoreJson,
  readStoreValue,
  writeStoreValue,
};
