import { Storage } from "@google-cloud/storage";
import type { Readable } from "node:stream";

const SIDECAR = "http://127.0.0.1:1106";

export type ThumbnailObjectMetadata = { contentType: string | undefined; size: number; generation: string };

export interface ThumbnailStorage {
  createSignedPutUrl(objectKey: string, contentType: string, expiresAt: Date): Promise<{
    uploadUrl: string;
    requiredHeaders: Record<string, string>;
  }>;
  getMetadata(objectKey: string, generation?: string): Promise<ThumbnailObjectMetadata>;
  readRange(objectKey: string, generation: string, start: number, end: number): Promise<Buffer>;
  promoteObject(sourceKey: string, sourceGeneration: string, destinationKey: string, contentType: string):
    Promise<ThumbnailObjectMetadata>;
  createReadStream(objectKey: string, generation?: string): Readable;
  deleteObject(objectKey: string): Promise<void>;
}

export class ThumbnailObjectNotFoundError extends Error {
  constructor() {
    super("Thumbnail object not found");
    this.name = "ThumbnailObjectNotFoundError";
  }
}

const client = new Storage({
  credentials: {
    audience: "replit",
    subject_token_type: "access_token",
    token_url: `${SIDECAR}/token`,
    type: "external_account",
    credential_source: {
      url: `${SIDECAR}/credential`,
      format: { type: "json", subject_token_field_name: "access_token" },
    },
    universe_domain: "googleapis.com",
  },
  projectId: "",
});

export class ReplitThumbnailStorage implements ThumbnailStorage {
  private readonly bucketName: string;
  private readonly prefix: string;

  constructor(privateObjectDir = process.env.PRIVATE_OBJECT_DIR ?? "") {
    const normalized = privateObjectDir.startsWith("/") ? privateObjectDir.slice(1) : privateObjectDir;
    const [bucketName, ...prefix] = normalized.split("/");
    if (!bucketName) throw new Error("PRIVATE_OBJECT_DIR is required for thumbnail storage");
    this.bucketName = bucketName;
    this.prefix = prefix.filter(Boolean).join("/");
  }

  private objectName(objectKey: string) {
    if (!/^[a-zA-Z0-9/_-]+$/.test(objectKey) || objectKey.includes("..") || objectKey.startsWith("/")) {
      throw new Error("Invalid private thumbnail object key");
    }
    return this.prefix ? `${this.prefix}/${objectKey}` : objectKey;
  }

  private file(objectKey: string, generation?: string) {
    return client.bucket(this.bucketName).file(this.objectName(objectKey), generation ? { generation } : undefined);
  }

  async createSignedPutUrl(objectKey: string, contentType: string, expiresAt: Date) {
    const response = await fetch(`${SIDECAR}/object-storage/signed-object-url`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        bucket_name: this.bucketName,
        object_name: this.objectName(objectKey),
        method: "PUT",
        expires_at: expiresAt.toISOString(),
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`App Storage signing failed (${response.status})`);
    const payload = await response.json() as { signed_url?: unknown };
    if (typeof payload.signed_url !== "string") throw new Error("App Storage signing returned no URL");
    const uploadUrl = new URL(payload.signed_url);
    if (uploadUrl.protocol !== "https:" || uploadUrl.username || uploadUrl.password
      || uploadUrl.port || uploadUrl.hash) {
      throw new Error("App Storage signing returned an unsafe URL");
    }
    return { uploadUrl: uploadUrl.toString(), requiredHeaders: { "Content-Type": contentType } };
  }

  async getMetadata(objectKey: string, generation?: string) {
    try {
      const [metadata] = await this.file(objectKey, generation).getMetadata();
      const size = Number(metadata.size);
      if (!Number.isSafeInteger(size) || size < 0) throw new Error("App Storage returned invalid object size");
      if (!metadata.generation) throw new Error("App Storage returned no immutable object generation");
      return { contentType: metadata.contentType, size, generation: String(metadata.generation) };
    } catch (error) {
      if (isNotFound(error)) throw new ThumbnailObjectNotFoundError();
      throw error;
    }
  }

  async readRange(objectKey: string, generation: string, start: number, end: number) {
    try {
      const [bytes] = await this.file(objectKey, generation).download({ start, end });
      return bytes;
    } catch (error) {
      if (isNotFound(error)) throw new ThumbnailObjectNotFoundError();
      throw error;
    }
  }

  async promoteObject(sourceKey: string, sourceGeneration: string, destinationKey: string, contentType: string) {
    try {
      const destination = this.file(destinationKey);
      await this.file(sourceKey, sourceGeneration).copy(destination, {
        preconditionOpts: { ifGenerationMatch: 0 },
        metadata: { contentType },
      });
      // App Storage's GCS-compatible copy currently drops the requested
      // Content-Type. Patch only the just-created immutable generation and
      // metageneration, then re-read it for finalize verification.
      const [copied] = await destination.getMetadata();
      if (!copied.generation || !copied.metageneration) {
        throw new Error("App Storage copy returned incomplete destination metadata");
      }
      await destination.setMetadata({ contentType }, {
        ifGenerationMatch: String(copied.generation),
        ifMetagenerationMatch: String(copied.metageneration),
      });
      return this.getMetadata(destinationKey, String(copied.generation));
    } catch (error) {
      if (isNotFound(error)) throw new ThumbnailObjectNotFoundError();
      throw error;
    }
  }

  createReadStream(objectKey: string, generation?: string) {
    return this.file(objectKey, generation).createReadStream();
  }

  async deleteObject(objectKey: string) {
    try {
      await this.file(objectKey).delete();
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
  }
}

function isNotFound(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error
    && (error as { code?: unknown }).code === 404;
}

let productionStorage: ThumbnailStorage | undefined;
export function getThumbnailStorage(locals?: Record<string, unknown>): ThumbnailStorage {
  const injected = locals?.thumbnailStorage;
  if (injected) return injected as ThumbnailStorage;
  return productionStorage ??= new ReplitThumbnailStorage();
}