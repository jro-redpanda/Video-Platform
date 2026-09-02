import {
  boolean,
  integer,
  index,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { organizationsTable, plansTable } from "./organizations";
import { usersTable } from "./identity";

export const billingStatusEnum = pgEnum("billing_status", [
  "unmanaged", "incomplete", "active", "trialing", "past_due", "unpaid", "canceled", "restricted", "quarantined",
]);
export const billingIntervalEnum = pgEnum("billing_interval", ["month", "year"]);
export const billingOperationStateEnum = pgEnum("billing_operation_state", ["claimed", "completed", "failed"]);

/** One tenant-owned, non-secret projection of the authoritative Stripe subscription. */
export const organizationBillingTable = pgTable("organization_billing", {
  organizationId: uuid("organization_id").primaryKey().references(() => organizationsTable.id, { onDelete: "cascade" }),
  stripeCustomerId: text("stripe_customer_id").unique(),
  stripeCustomerGeneration: integer("stripe_customer_generation").notNull().default(0),
  stripeCustomerCreationOperationId: uuid("stripe_customer_creation_operation_id"),
  stripeSubscriptionId: text("stripe_subscription_id").unique(),
  stripeSubscriptionStatus: text("stripe_subscription_status").$type<
    "incomplete" | "incomplete_expired" | "trialing" | "active" | "past_due" | "canceled" | "unpaid" | "paused"
  >(),
  status: billingStatusEnum("status").notNull().default("unmanaged"),
  interval: billingIntervalEnum("interval"),
  currentPlanId: uuid("current_plan_id").references(() => plansTable.id, { onDelete: "restrict" }),
  periodStart: timestamp("period_start", { withTimezone: true }),
  periodEnd: timestamp("period_end", { withTimezone: true }),
  cancelAtPeriodEnd: boolean("cancel_at_period_end").notNull().default(false),
  pendingPlanId: uuid("pending_plan_id").references(() => plansTable.id, { onDelete: "restrict" }),
  pendingEffectiveAt: timestamp("pending_effective_at", { withTimezone: true }),
  /** Checkout is pending payment only; this never changes paid/grandfathered access. */
  pendingCheckoutSessionId: text("pending_checkout_session_id"),
  pendingCheckoutPlanId: uuid("pending_checkout_plan_id").references(() => plansTable.id, { onDelete: "restrict" }),
  pendingCheckoutPriceId: text("pending_checkout_price_id"),
  pendingCheckoutInterval: billingIntervalEnum("pending_checkout_interval"),
  pendingCheckoutExpiresAt: timestamp("pending_checkout_expires_at", { withTimezone: true }),
  pendingCheckoutOperationId: uuid("pending_checkout_operation_id"),
  graceEndsAt: timestamp("grace_ends_at", { withTimezone: true }),
  lastStripeEventId: text("last_stripe_event_id"),
  lastStripeObjectVersion: text("last_stripe_object_version"),
  lastReconciledAt: timestamp("last_reconciled_at", { withTimezone: true }),
  lastErrorCode: text("last_error_code"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("organization_billing_status_idx").on(table.status, table.updatedAt),
  index("organization_billing_reconcile_idx").on(table.lastReconciledAt),
]);

/** Persisted before each external billing effect; request data intentionally excludes payment details. */
export const billingOperationsTable = pgTable("billing_operations", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  actorUserId: uuid("actor_user_id").references(() => usersTable.id, { onDelete: "set null" }),
  operation: text("operation").notNull(),
  idempotencyKey: text("idempotency_key").notNull(),
  state: billingOperationStateEnum("state").notNull().default("claimed"),
  requestFingerprint: text("request_fingerprint").notNull(),
  stripeObjectId: text("stripe_object_id"),
  result: jsonb("result").$type<Record<string, string | boolean | number | null>>(),
  errorCode: text("error_code"),
  claimedAt: timestamp("claimed_at", { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("billing_operations_idempotency_idx").on(table.organizationId, table.operation, table.idempotencyKey),
  index("billing_operations_claimed_idx").on(table.state, table.claimedAt),
]);

/** Receipt metadata, not provider payloads, for monotonic reconciliation/auditing. */
export const billingEventReceiptsTable = pgTable("billing_event_receipts", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").references(() => organizationsTable.id, { onDelete: "set null" }),
  stripeEventId: text("stripe_event_id").notNull(),
  stripeObjectId: text("stripe_object_id"),
  stripeObjectVersion: text("stripe_object_version"),
  eventType: text("event_type").notNull(),
  processingState: text("processing_state").notNull().default("received"),
  diagnosticCode: text("diagnostic_code"),
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  processedAt: timestamp("processed_at", { withTimezone: true }),
}, (table) => [
  uniqueIndex("billing_event_receipts_stripe_event_idx").on(table.stripeEventId),
  index("billing_event_receipts_pending_idx").on(table.processingState, table.receivedAt),
]);