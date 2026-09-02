import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { ReplitThumbnailStorage } from "./lib/thumbnail-storage";

if (!process.env.PRIVATE_OBJECT_DIR) {
  console.log("Real App Storage thumbnail round-trip skipped (storage environment unavailable)");
  process.exit(0);
}

const storage = new ReplitThumbnailStorage();
const scope = randomUUID();
const candidateKey = `thumbnail-candidates/storage-smoke/${scope}`;
const finalKey = `thumbnail-finals/storage-smoke/${randomUUID()}`;
const contentType = "image/jpeg";
const bytes = Buffer.from(
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABBQJ//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAwEBPwF//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAgEBPwF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQAGPwJ//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPyF//9oADAMBAAIAAwAAABD/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAEDAQE/EB//xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAECAQE/EB//xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAE/EB//2Q==",
  "base64",
);

try {
  const signed = await storage.createSignedPutUrl(candidateKey, contentType, new Date(Date.now() + 5 * 60_000));
  const uploaded = await fetch(signed.uploadUrl, {
    method: "PUT",
    headers: signed.requiredHeaders,
    body: bytes,
    signal: AbortSignal.timeout(30_000),
  });
  assert.equal(uploaded.status, 200);

  const candidate = await storage.getMetadata(candidateKey);
  assert.equal(candidate.contentType, contentType);
  assert.equal(candidate.size, bytes.length);
  assert.equal((await storage.readRange(candidateKey, candidate.generation, 0, 3)).toString("hex"), "ffd8ffe0");

  const promoted = await storage.promoteObject(candidateKey, candidate.generation, finalKey, contentType);
  assert.equal(promoted.contentType, contentType);
  assert.equal(promoted.size, bytes.length);
  assert(promoted.generation);
  const finalBytes = await storage.readRange(finalKey, promoted.generation, 0, bytes.length - 1);
  assert.deepEqual(finalBytes, bytes);
  assert.equal(finalBytes.subarray(0, 4).toString("hex"), "ffd8ffe0");
  console.log("Real App Storage thumbnail round-trip passed");
} finally {
  await Promise.allSettled([
    storage.deleteObject(candidateKey),
    storage.deleteObject(finalKey),
  ]);
}