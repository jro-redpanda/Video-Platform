import { createHash } from "node:crypto";

export const normalizeInvitationEmail = (email: string) =>
  email.normalize("NFKC").trim().toLowerCase();

export const isInvitationToken = (token: unknown): token is string =>
  typeof token === "string" && /^[A-Za-z0-9_-]{43}$/.test(token);

export const hashInvitationToken = (token: string) =>
  createHash("sha256").update(token).digest("hex");