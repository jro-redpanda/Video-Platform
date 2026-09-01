import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { promisify } from "node:util";
import { BunnyVideoProvider, type EncodeCompletionEvent } from "@workspace/providers";

const execFileAsync = promisify(execFile);

type PendingCallback = {
  provider: BunnyVideoProvider;
  libraryId: string;
  videoId: string;
  resolve: (event: EncodeCompletionEvent) => void;
};

const pendingCallbacks = new Map<string, PendingCallback>();

export function receiveBunnyRoundTripCallback(
  token: string,
  rawBody: Buffer,
  headers: Readonly<Record<string, string | string[] | undefined>>,
) {
  const pending = pendingCallbacks.get(token);
  if (!pending) return { accepted: false, terminal: false };
  const event = pending.provider.verifyEncodeCompletionCallback(rawBody, headers);
  if (!event) return { accepted: true, terminal: false };
  if (event.tenantSpaceId !== pending.libraryId || event.assetId !== pending.videoId) {
    return { accepted: false, terminal: false };
  }
  pending.resolve(event);
  return { accepted: true, terminal: true };
}

export async function runBunnyRoundTrip(jobId: string) {
  const accountApiKey = process.env.BUNNY_API_KEY;
  const devDomain = process.env.REPLIT_DEV_DOMAIN;
  if (!accountApiKey) throw new Error("BUNNY_API_KEY is required");
  if (!devDomain) throw new Error("REPLIT_DEV_DOMAIN is required for the Bunny webhook round trip");

  const provider = new BunnyVideoProvider({ accountApiKey });
  const token = randomUUID();
  const filePath = `/tmp/bunny-roundtrip-${jobId}.mp4`;
  let space: { id: string } | undefined;

  try {
    await execFileAsync("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-y",
      "-f", "lavfi", "-i", "color=c=black:s=320x180:d=1",
      "-f", "lavfi", "-i", "anullsrc=r=44100:cl=stereo",
      "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-movflags", "+faststart", filePath,
    ]);
    const videoBytes = await readFile(filePath);
    space = await provider.createTenantSpace({ name: `vid-step6-${jobId.slice(0, 8)}` });
    await provider.setEncodeCompletionCallback(
      space,
      `https://${devDomain}/api/provider-tests/bunny/${token}`,
    );
    const asset = await provider.createAsset(space, { title: "Step 6 adapter verification" });
    const credentials = await provider.getUploadCredentials(space, asset, {
      fileName: "verification.mp4",
      contentType: "video/mp4",
      contentLength: videoBytes.length,
    });
    if (credentials.kind !== "tus") throw new Error("Bunny did not return tus credentials");

    const terminalEvent = new Promise<EncodeCompletionEvent>((resolve) => {
      pendingCallbacks.set(token, {
        provider,
        libraryId: space!.id,
        videoId: asset.id,
        resolve,
      });
    });
    await uploadTus(credentials.endpoint, credentials.headers, videoBytes);
    const event = await withTimeout(terminalEvent, 15 * 60_000, "Timed out waiting for Bunny encode webhook");
    if (event.status.state !== "ready") {
      throw new Error(`Bunny encoding failed: ${event.status.reason}`);
    }
    const status = await provider.getAssetStatus(space, asset);
    if (status.state !== "ready") throw new Error(`Bunny API did not report ready after webhook: ${status.state}`);

    return {
      libraryId: space.id,
      videoId: asset.id,
      uploadProtocol: credentials.kind,
      webhookSignatureVersion: "v1",
      webhookAlgorithm: "hmac-sha256",
      terminalState: status.state,
      durationSeconds: status.durationSeconds,
      disposableLibraryDeleted: true,
    };
  } finally {
    pendingCallbacks.delete(token);
    await rm(filePath, { force: true });
    if (space) await provider.deleteTenantSpace(space);
  }
}

async function uploadTus(endpoint: string, authorization: Readonly<Record<string, string>>, body: Buffer) {
  const metadata = [
    `filename ${Buffer.from("verification.mp4").toString("base64")}`,
    `filetype ${Buffer.from("video/mp4").toString("base64")}`,
    `title ${Buffer.from("Step 6 adapter verification").toString("base64")}`,
  ].join(",");
  const create = await fetch(endpoint, {
    method: "POST",
    headers: {
      ...authorization,
      "Tus-Resumable": "1.0.0",
      "Upload-Length": String(body.length),
      "Upload-Metadata": metadata,
    },
  });
  if (!create.ok) throw new Error(`Bunny tus create failed (${create.status}): ${(await create.text()).slice(0, 500)}`);
  const location = create.headers.get("location");
  if (!location) throw new Error("Bunny tus create omitted the Location header");
  const uploadUrl = new URL(location, endpoint).toString();
  const upload = await fetch(uploadUrl, {
    method: "PATCH",
    headers: {
      ...authorization,
      "Tus-Resumable": "1.0.0",
      "Upload-Offset": "0",
      "Content-Type": "application/offset+octet-stream",
    },
    body,
  });
  if (!upload.ok) throw new Error(`Bunny tus upload failed (${upload.status}): ${(await upload.text()).slice(0, 500)}`);
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}