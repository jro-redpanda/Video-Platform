import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  type ArchiveColdMasterInput,
  type ColdMasterByteStream,
  type ColdMasterObjectMetadata,
  type ColdMasterStorage,
  ColdMasterDefinitiveWriteRejectionError,
  ColdMasterIntegrityMismatchError,
  ColdMasterObjectNotFoundError,
  ColdMasterStorageUnavailableError,
  coldMasterStorage,
  createColdMasterObjectKey,
} from "./lib/cold-master-storage.js";
import {
  type ColdMasterProviderAssetSnapshot,
  type ColdMasterTransfer,
  type RestoreColdMasterTargetInput,
  ColdMasterTransferUnavailableError,
  coldMasterTransfer,
} from "./lib/cold-master-transfer.js";

const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const asStream = async function* (bytes: Uint8Array): ColdMasterByteStream {
  yield bytes.subarray(0, 2);
  yield bytes.subarray(2);
};
async function collect(stream: ColdMasterByteStream): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

/** Test-only adapter: this is intentionally not a production fallback. */
class InMemoryColdMasterStorage implements ColdMasterStorage {
  readonly availability = { kind: "available", configuration: "configured" } as const;
  private readonly objects = new Map<string, ColdMasterObjectMetadata & { bytes: Buffer }>();

  async archive(input: ArchiveColdMasterInput): Promise<ColdMasterObjectMetadata> {
    const bytes = await collect(input.body);
    if (bytes.length !== input.contentLength || digest(bytes) !== input.sha256) {
      throw new ColdMasterIntegrityMismatchError(input.storageKey);
    }
    const existing = this.objects.get(input.storageKey);
    if (existing) {
      if (existing.size !== input.contentLength || existing.contentType !== input.contentType ||
          existing.sha256 !== input.sha256 || !existing.bytes.equals(bytes)) {
        throw new ColdMasterDefinitiveWriteRejectionError(input.storageKey, "key_collision");
      }
      return {
        storageKey: existing.storageKey,
        size: existing.size,
        contentType: existing.contentType,
        sha256: existing.sha256,
      };
    }
    const result = { storageKey: input.storageKey, size: input.contentLength, contentType: input.contentType, sha256: input.sha256 };
    this.objects.set(input.storageKey, { ...result, bytes });
    return result;
  }

  async restore(storageKey: string) {
    const object = this.objects.get(storageKey);
    if (!object) throw new ColdMasterObjectNotFoundError(storageKey);
    if (digest(object.bytes) !== object.sha256) throw new ColdMasterIntegrityMismatchError(storageKey);
    return { ...object, body: asStream(object.bytes) };
  }
}
/** Test-only persisted-asset fake. It verifies the transfer boundary uses bytes, not names. */
class InMemoryColdMasterTransfer implements ColdMasterTransfer {
  readonly availability = { kind: "available", configuration: "configured" } as const;
  readonly source = new Map<string, Buffer>();
  readonly targets = new Map<string, Buffer>();
  readonly writes = new Map<string, string>();
  private key(snapshot: ColdMasterProviderAssetSnapshot) { return `${snapshot.providerAccountId}:${snapshot.providerTenantSpaceId}:${snapshot.providerAssetId}`; }
  async openSource(snapshot: ColdMasterProviderAssetSnapshot) {
    const bytes = this.source.get(this.key(snapshot));
    assert.ok(bytes, "source must be a persisted provider asset");
    return { source: snapshot, contentLength: bytes.length, contentType: "video/mp4", sha256: digest(bytes), body: asStream(bytes) };
  }
  async restoreToTarget(input: RestoreColdMasterTargetInput) {
    assert.ok(input.idempotencyKey.length > 0, "restore idempotency is mandatory");
    const bytes = await collect(input.body);
    assert.equal(digest(bytes), input.sha256);
    const target = this.key(input.target), seen = this.writes.get(input.idempotencyKey);
    if (seen) { assert.equal(seen, target); return { target: input.target, idempotencyKey: input.idempotencyKey, contentLength: input.contentLength, contentType: input.contentType, sha256: input.sha256 }; }
    this.writes.set(input.idempotencyKey, target); this.targets.set(target, bytes);
    return { target: input.target, idempotencyKey: input.idempotencyKey, contentLength: input.contentLength, contentType: input.contentType, sha256: input.sha256 };
  }
}

async function expectError<T extends Error & { code: string }>(
  promise: Promise<unknown>,
  Type: new (...args: never[]) => T,
  code: string,
) {
  await assert.rejects(promise, (error: unknown) => error instanceof Type && error.code === code);
}

async function main() {
  const bytes = Buffer.from("exact cold bytes");
  const sha256 = digest(bytes);
  const key = createColdMasterObjectKey({ organizationId: "org_1", videoId: "video_1", sha256 });
  assert.equal(key, createColdMasterObjectKey({ organizationId: "org_1", videoId: "video_1", sha256 }));
  assert.throws(() => createColdMasterObjectKey({ organizationId: "../org", videoId: "video_1", sha256 }),
    ColdMasterDefinitiveWriteRejectionError);

  const storage = new InMemoryColdMasterStorage();
  const input = (): ArchiveColdMasterInput => ({ storageKey: key, body: asStream(bytes), contentLength: bytes.length, contentType: "video/mp4", sha256 });
  const archived = await storage.archive(input());
  assert.deepEqual(archived, { storageKey: key, size: bytes.length, contentType: "video/mp4", sha256 });
  assert.deepEqual(await storage.archive(input()), archived);
  await expectError(storage.archive({ ...input(), contentType: "application/octet-stream" }),
    ColdMasterDefinitiveWriteRejectionError, "COLD_MASTER_WRITE_REJECTED");
  await expectError(storage.archive({ ...input(), sha256: "0".repeat(64) }),
    ColdMasterIntegrityMismatchError, "COLD_MASTER_INTEGRITY_MISMATCH");
  await expectError(storage.restore("v1/missing"), ColdMasterObjectNotFoundError, "COLD_MASTER_OBJECT_NOT_FOUND");

  const restored = await storage.restore(key);
  assert.deepEqual({ storageKey: restored.storageKey, size: restored.size, contentType: restored.contentType, sha256: restored.sha256 }, archived);
  assert.deepEqual(await collect(restored.body), bytes);
  assert.deepEqual(await collect((await storage.restore(key)).body), bytes);

  assert.deepEqual(coldMasterStorage.availability, { kind: "unavailable", configuration: "not_configured" });
  await expectError(coldMasterStorage.archive(input()), ColdMasterStorageUnavailableError, "COLD_MASTER_STORAGE_UNAVAILABLE");
  await expectError(coldMasterStorage.restore(key), ColdMasterStorageUnavailableError, "COLD_MASTER_STORAGE_UNAVAILABLE");
  assert.deepEqual(coldMasterTransfer.availability, { kind: "unavailable", configuration: "not_configured" });
  await expectError(coldMasterTransfer.openSource({ providerAccountId: "a", providerTenantSpaceId: "s", providerAssetId: "v" }), ColdMasterTransferUnavailableError, "COLD_MASTER_TRANSFER_UNAVAILABLE");
  const transfer = new InMemoryColdMasterTransfer(), snapshot = { providerAccountId: "account", providerTenantSpaceId: "space", providerAssetId: "asset" };
  transfer.source.set("account:space:asset", bytes);
  const source = await transfer.openSource(snapshot);
  await transfer.restoreToTarget({ target: snapshot, idempotencyKey: "durable-operation-id", contentLength: source.contentLength, contentType: source.contentType, sha256: source.sha256, body: source.body });
  await transfer.restoreToTarget({ target: snapshot, idempotencyKey: "durable-operation-id", contentLength: bytes.length, contentType: "video/mp4", sha256, body: asStream(bytes) });
  assert.deepEqual(transfer.targets.get("account:space:asset"), bytes);
  console.log("cold-master storage conformance smoke passed");
}

void main();