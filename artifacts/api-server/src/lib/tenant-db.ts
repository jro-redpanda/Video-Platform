import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import type { TenantContext } from "./tenant-context";

export type TenantTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

export async function withOrganizationDb<T>(
  organizationId: string,
  operation: (tx: TenantTransaction) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql.raw("set local role vid_app"));
    await tx.execute(sql`select set_config('app.organization_id', ${organizationId}, true)`);
    return operation(tx);
  });
}

export async function withTenantDb<T>(
  tenant: TenantContext,
  operation: (tx: TenantTransaction) => Promise<T>,
  options?: { isolationLevel?: "repeatable read" },
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql.raw("set local role vid_app"));
    await tx.execute(sql`select set_config('app.organization_id', ${tenant.organizationId}, true)`);
    await tx.execute(sql`select set_config('app.user_id', ${tenant.userId}, true)`);
    return operation(tx);
  }, options);
}