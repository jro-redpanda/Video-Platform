/**
 * A configured adapter may still be unable to reach its backing service. This
 * describes only whether an adapter was configured, never external health.
 */
export type ColdMasterStorageAvailability =
  | Readonly<{ kind: "available"; configuration: "configured" }>
  | Readonly<{ kind: "unavailable"; configuration: "not_configured" }>;

export type ColdMasterByteStream = AsyncIterable<Uint8Array>;

export interface ColdMasterObjectMetadata {
  readonly storageKey: string;
  readonly size: number;
  readonly contentType: string;
  readonly sha256: string;
}

export interface ArchiveColdMasterInput {
  readonly storageKey: string;
  readonly contentLength: number;
  readonly contentType: string;
  readonly sha256: string;
  /**
   * The object is conditionally created. A replay is successful only when the
   * object already stored at this key has this exact metadata and content.
   */
  readonly body: ColdMasterByteStream;
}

export interface RestoreColdMasterResult extends ColdMasterObjectMetadata {
  /** A new, consumable byte stream for this restore invocation. */
  readonly body: ColdMasterByteStream;
}

export class ColdMasterStorageUnavailableError extends Error {
  static readonly code = "COLD_MASTER_STORAGE_UNAVAILABLE";
  readonly code = ColdMasterStorageUnavailableError.code;

  constructor() {
    super("Cold storage is not configured");
    this.name = "ColdMasterStorageUnavailableError";
  }
}

export class ColdMasterObjectNotFoundError extends Error {
  static readonly code = "COLD_MASTER_OBJECT_NOT_FOUND";
  readonly code = ColdMasterObjectNotFoundError.code;

  constructor(readonly storageKey: string) {
    super("Cold storage object was not found");
    this.name = "ColdMasterObjectNotFoundError";
  }
}

export class ColdMasterIntegrityMismatchError extends Error {
  static readonly code = "COLD_MASTER_INTEGRITY_MISMATCH";
  readonly code = ColdMasterIntegrityMismatchError.code;

  constructor(readonly storageKey: string) {
    super("Cold storage object integrity did not match");
    this.name = "ColdMasterIntegrityMismatchError";
  }
}

/**
 * A write rejected with certainty, including a conditional-create collision.
 * Retrying cannot turn this result into a successful write.
 */
export class ColdMasterDefinitiveWriteRejectionError extends Error {
  static readonly code = "COLD_MASTER_WRITE_REJECTED";
  readonly code = ColdMasterDefinitiveWriteRejectionError.code;

  constructor(
    readonly storageKey: string,
    readonly reason: "key_collision" | "invalid_input",
  ) {
    super("Cold storage write was definitively rejected");
    this.name = "ColdMasterDefinitiveWriteRejectionError";
  }
}

export interface ColdMasterStorage {
  readonly availability: ColdMasterStorageAvailability;

  /**
   * Conditionally create an object. Implementations must not overwrite an
   * existing object: matching replays return its metadata; all other
   * collisions reject with ColdMasterDefinitiveWriteRejectionError.
   */
  archive(input: ArchiveColdMasterInput): Promise<ColdMasterObjectMetadata>;
  restore(storageKey: string): Promise<RestoreColdMasterResult>;
}

const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const SHA256 = /^[a-f0-9]{64}$/;

/**
 * Produces a stable key without accepting path syntax in any caller-supplied
 * segment. The digest is deliberately part of the key, making a content
 * replacement a distinct conditional-create target.
 */
export function createColdMasterObjectKey(input: {
  organizationId: string;
  videoId: string;
  sha256: string;
}): string {
  if (!SAFE_IDENTIFIER.test(input.organizationId) || !SAFE_IDENTIFIER.test(input.videoId) || !SHA256.test(input.sha256)) {
    throw new ColdMasterDefinitiveWriteRejectionError("", "invalid_input");
  }
  return `v1/${input.organizationId}/${input.videoId}/${input.sha256}`;
}

export class UnconfiguredColdMasterStorage implements ColdMasterStorage {
  readonly availability: ColdMasterStorageAvailability = {
    kind: "unavailable",
    configuration: "not_configured",
  };

  async archive(_input: ArchiveColdMasterInput): Promise<ColdMasterObjectMetadata> {
    throw new ColdMasterStorageUnavailableError();
  }

  async restore(_storageKey: string): Promise<RestoreColdMasterResult> {
    throw new ColdMasterStorageUnavailableError();
  }
}

/** Production deliberately starts fail-closed. Test replacement is not an HTTP capability. */
export const coldMasterStorage: ColdMasterStorage = new UnconfiguredColdMasterStorage();
let runtimeColdMasterStorage: ColdMasterStorage = coldMasterStorage;

export function getRuntimeColdMasterStorage(): ColdMasterStorage {
  return runtimeColdMasterStorage;
}

export function setRuntimeColdMasterStorageForTest(storage?: ColdMasterStorage): void {
  if (process.env.NODE_ENV !== "test") throw new Error("Cold master test adapters require NODE_ENV=test");
  runtimeColdMasterStorage = storage ?? coldMasterStorage;
}