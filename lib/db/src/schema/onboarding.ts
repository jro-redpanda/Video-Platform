import { boolean, index, integer, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { organizationsTable } from "./organizations";
import { usersTable } from "./identity";

export const onboardingIntentStateEnum = pgEnum("onboarding_intent_state", [
  "pending",
  "dispatching",
  "queued",
  "processing",
  "unavailable",
  "failed",
  "reconciliation_required",
  "completed",
]);

export const onboardingProvisioningIntentsTable = pgTable("onboarding_provisioning_intents", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  requestedByUserId: uuid("requested_by_user_id").notNull().references(() => usersTable.id, { onDelete: "restrict" }),
  state: onboardingIntentStateEnum("state").notNull().default("pending"),
  retryable: boolean("retryable").notNull().default(true),
  attempts: integer("attempts").notNull().default(0),
  diagnosticCode: text("diagnostic_code"),
  dispatchClaim: uuid("dispatch_claim"),
  claimedAt: timestamp("claimed_at", { withTimezone: true }),
  dispatchedAt: timestamp("dispatched_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (table) => [
  uniqueIndex("onboarding_intents_org_idx").on(table.organizationId),
  index("onboarding_intents_dispatch_idx").on(table.state, table.createdAt),
  index("onboarding_intents_user_idx").on(table.requestedByUserId),
]);

export type OnboardingProvisioningIntent = typeof onboardingProvisioningIntentsTable.$inferSelect;