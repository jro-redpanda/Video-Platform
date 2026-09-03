import type { ColdMasterByteStream } from "./cold-master-storage";

/**
 * This boundary owns provider reads and writes, not cold-object persistence.
 * `available` means an implementation was supplied; it is deliberately not a
 * provider health assertion.
 */
export type ColdMasterTransferAvailability =
  | Readonly<{ kind: "available"; configuration: "configured" }>
  | Readonly<{ kind: "unavailable"; configuration: "not_configured" }>;

/**
 * Provider identity is copied into the durable operation before work starts.
 * It is intentionally an opaque identity snapshot: neither a display name nor
 * an upload filename is a source of bytes.
 */
export interface ColdMasterProviderAssetSnapshot {
  readonly providerAccountId: string;
  readonly providerTenantSpaceId: string;
  readonly providerAssetId: string;
}

/**
 * The target is also persisted with the operation.  An adapter must use the
 * operation's idempotency key when creating/writing it so a stale worker can
 * safely repeat a restore.
 */
export interface ColdMasterRestoreTargetSnapshot extends ColdMasterProviderAssetSnapshot {}

export interface OpenColdMasterSourceResult {
  readonly contentLength: number;
  readonly contentType: string;
  readonly sha256: string;
  /** A fresh consumable stream; callers must never substitute a filename. */
  readonly body: ColdMasterByteStream;
}

export interface RestoreColdMasterTargetInput {
  readonly target: ColdMasterRestoreTargetSnapshot;
  readonly idempotencyKey: string;
  readonly contentLength: number;
  readonly contentType: string;
  readonly sha256: string;
  readonly body: ColdMasterByteStream;
}

/** Evidence returned only after a target has durably accepted the whole stream. */
export interface RestoreColdMasterTargetResult {
  /** Must equal the input's durable idempotency key, including on a replay. */
  readonly idempotencyKey: string;
  readonly contentLength: number;
  readonly contentType: string;
  readonly sha256: string;
  /** Optional provider version/identity evidence for later reconciliation. */
  readonly targetVersion?: string;
}

/**
 * A transfer adapter is distinct from cold storage.  It only moves bytes
 * between a finalized immutable provider source snapshot and a target snapshot.
 * A successful target result attests an idempotent, verified write of exactly
 * the supplied bytes; callers verify that attestation before completing work.
 */
export interface ColdMasterTransfer {
  readonly availability: ColdMasterTransferAvailability;
  openSource(snapshot: ColdMasterProviderAssetSnapshot): Promise<OpenColdMasterSourceResult>;
  restoreToTarget(input: RestoreColdMasterTargetInput): Promise<RestoreColdMasterTargetResult>;
}

/** A configuration/runtime outage for which another attempt may succeed. */
export class ColdMasterTransferUnavailableError extends Error {
  static readonly code = "COLD_MASTER_TRANSFER_UNAVAILABLE";
  readonly code = ColdMasterTransferUnavailableError.code;

  constructor() {
    super("Master transfer is not configured");
    this.name = "ColdMasterTransferUnavailableError";
  }
}

/** A temporary provider-side failure; the durable worker may retry it. */
export class ColdMasterTransferTransientError extends Error {
  static readonly code = "COLD_MASTER_TRANSFER_TRANSIENT";
  readonly code = ColdMasterTransferTransientError.code;

  constructor() {
    super("Master transfer could not be completed");
    this.name = "ColdMasterTransferTransientError";
  }
}

/** A certain provider-side rejection. Retrying cannot make it succeed. */
export class ColdMasterTransferDefinitiveError extends Error {
  static readonly code = "COLD_MASTER_TRANSFER_REJECTED";
  readonly code = ColdMasterTransferDefinitiveError.code;

  constructor(readonly reason: "source_not_found" | "target_rejected" | "invalid_snapshot" | "integrity_mismatch") {
    super("Master transfer was definitively rejected");
    this.name = "ColdMasterTransferDefinitiveError";
  }
}

/** Fail closed: applications must explicitly install a real transfer adapter. */
export class UnconfiguredColdMasterTransfer implements ColdMasterTransfer {
  readonly availability: ColdMasterTransferAvailability = {
    kind: "unavailable",
    configuration: "not_configured",
  };

  async openSource(_snapshot: ColdMasterProviderAssetSnapshot): Promise<OpenColdMasterSourceResult> {
    throw new ColdMasterTransferUnavailableError();
  }

  async restoreToTarget(_input: RestoreColdMasterTargetInput): Promise<RestoreColdMasterTargetResult> {
    throw new ColdMasterTransferUnavailableError();
  }
}

/** Production deliberately starts fail-closed. Test replacement is not an HTTP capability. */
export const coldMasterTransfer: ColdMasterTransfer = new UnconfiguredColdMasterTransfer();
let runtimeColdMasterTransfer: ColdMasterTransfer = coldMasterTransfer;

export function getRuntimeColdMasterTransfer(): ColdMasterTransfer {
  return runtimeColdMasterTransfer;
}

export function setRuntimeColdMasterTransferForTest(transfer?: ColdMasterTransfer): void {
  if (process.env.NODE_ENV !== "test") throw new Error("Cold master test adapters require NODE_ENV=test");
  runtimeColdMasterTransfer = transfer ?? coldMasterTransfer;
}