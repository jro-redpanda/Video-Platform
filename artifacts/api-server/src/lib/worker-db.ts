import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import type { TenantTransaction } from "./tenant-db";

export type WorkerScope =
  | "analytics"
  | "billing"
  | "custom_domain"
  | "embed"
  | "master_storage"
  | "onboarding"
  | "thumbnail"
  | "upload_expiry";

const scopeSetting: Record<WorkerScope, string> = {
  analytics: "app.analytics_worker",
  billing: "app.billing_worker",
  custom_domain: "app.custom_domain_worker",
  embed: "app.embed_worker",
  master_storage: "app.master_storage_worker",
  onboarding: "app.onboarding_worker",
  thumbnail: "app.thumbnail_worker",
  upload_expiry: "app.upload_expiry_worker",
};

/**
 * Runs one atomic database unit as the narrow cross-tenant maintenance role.
 * External provider, queue, DNS, and object-storage calls must remain outside.
 */
export async function withWorkerDb<T>(
  scope: WorkerScope,
  operation: (tx: TenantTransaction) => Promise<T>,
) {
  return db.transaction(async (tx) => {
    await tx.execute(sql.raw("set local role vid_app"));
    await tx.execute(sql.raw("set local role vid_worker"));
    await tx.execute(sql`select set_config(${scopeSetting[scope]}, 'on', true)`);
    return operation(tx);
  });
}