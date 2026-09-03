import { embedGenerationOutboxTable, videoEmbedsTable, videosTable } from "@workspace/db";
import { and, eq, inArray } from "drizzle-orm";
import type { Request } from "express";
import { auditJob, writeAuditEvent } from "./audit";
import { withWorkerDb } from "./worker-db";

export const EMBED_GENERATION_VERSION = 1;

/** `outboxId` is the deterministic pg-boss job id; never complete a sibling receipt. */
export async function generateVideoEmbed(videoId: string, outboxId?: string) {
  return withWorkerDb("embed", async (tx) => {
    const [video] = await tx.select({
      id: videosTable.id,
      title: videosTable.title,
      description: videosTable.description,
      durationSeconds: videosTable.durationSeconds,
      organizationId: videosTable.organizationId,
    }).from(videosTable).where(eq(videosTable.id, videoId)).limit(1);
    if (!video) throw new Error(`Owned video ${videoId} does not exist`);

    const now = new Date();
    const metadata = {
      title: video.title,
      description: video.description,
      durationSeconds: video.durationSeconds,
    };
    const [prior] = await tx.select().from(videoEmbedsTable).where(eq(videoEmbedsTable.videoId, videoId)).limit(1);
    const [embed] = await tx.insert(videoEmbedsTable).values({
      videoId,
      embedPath: `/v/${videoId}`,
      generationVersion: EMBED_GENERATION_VERSION,
      generationStatus: "generated",
      generatedMetadata: metadata,
      generatedAt: now,
    }).onConflictDoUpdate({
      target: videoEmbedsTable.videoId,
      set: {
        embedPath: `/v/${videoId}`,
        generationVersion: EMBED_GENERATION_VERSION,
        generationStatus: "generated",
        generatedMetadata: metadata,
        generatedAt: now,
        updatedAt: now,
      },
    }).returning();
    const changed = !prior || prior.generationStatus !== "generated"
      || prior.generationVersion !== EMBED_GENERATION_VERSION
      || JSON.stringify(prior.generatedMetadata) !== JSON.stringify(metadata);
    if (changed) await writeAuditEvent(tx, {
      organizationId: video.organizationId, actor: auditJob(),
      action: prior ? "embed.regenerated" : "embed.generated", category: "embed",
      subject: { type: "video", id: videoId, label: video.title },
      beforeState: prior ? { generationStatus: prior.generationStatus, generationVersion: prior.generationVersion } : undefined,
      afterState: { generationStatus: "generated", generationVersion: EMBED_GENERATION_VERSION },
    });

    if (outboxId) {
      await tx.update(embedGenerationOutboxTable).set({
        state: "completed",
        completedAt: now,
        dispatchClaim: null,
        diagnosticCode: null,
      }).where(and(
        eq(embedGenerationOutboxTable.id, outboxId),
        eq(embedGenerationOutboxTable.videoId, videoId),
        inArray(embedGenerationOutboxTable.state, ["dispatched", "dispatching"]),
      ));
    }
    return embed;
  });
}

export function trustedRequestOrigin(req: Request) {
  const configured = process.env.PUBLIC_APP_ORIGIN?.trim();
  if (configured) {
    const url = new URL(configured);
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("PUBLIC_APP_ORIGIN must use HTTP or HTTPS");
    return url.origin;
  }
  const host = req.get("host");
  if (!host || !/^[a-z0-9.[\]:-]+$/i.test(host)) throw new Error("A valid request host is required");
  const allowedHosts = process.env.REPLIT_DOMAINS?.split(",").map((value) => value.trim().toLowerCase()).filter(Boolean) ?? [];
  const normalizedHost = host.toLowerCase().replace(/:443$/, "");
  // Isolated smoke servers bind an ephemeral loopback port while the ambient
  // Replit allowlist still contains the preview domain. This is test-only;
  // production continues to require the configured trusted host.
  if (process.env.NODE_ENV === "test" && /^(?:127\.0\.0\.1|localhost)(?::\d+)?$/i.test(normalizedHost)) {
    return `${req.protocol}://${host}`;
  }
  if (allowedHosts.length && !allowedHosts.includes(normalizedHost)) throw new Error("Request host is not allowlisted");
  if (process.env.NODE_ENV === "production" && !allowedHosts.length) throw new Error("A trusted public origin is not configured");
  return `${req.protocol}://${host}`;
}

export function serializeEmbed(
  embed: typeof videoEmbedsTable.$inferSelect,
  origin: string,
  currentMetadata = embed.generatedMetadata,
) {
  const embedUrl = new URL(embed.embedPath, origin).toString();
  const title = `${currentMetadata.title} video player`;
  const embedCode = `<div style="position:relative;padding-top:56.25%;overflow:hidden"><iframe src="${escapeAttribute(embedUrl)}" title="${escapeAttribute(title)}" loading="lazy" allow="autoplay; fullscreen; picture-in-picture" allowfullscreen style="position:absolute;inset:0;width:100%;height:100%;border:0"></iframe></div>`;
  return {
    embedUrl,
    embedPath: embed.embedPath,
    embedCode,
    videoObject: {
      "@context": "https://schema.org" as const,
      "@type": "VideoObject" as const,
      name: currentMetadata.title,
      description: currentMetadata.description,
      embedUrl,
      duration: isoDuration(currentMetadata.durationSeconds),
    },
  };
}

function isoDuration(seconds: number) {
  return `PT${Math.max(0, Math.round(seconds))}S`;
}

function escapeAttribute(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}