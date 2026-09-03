import { betterAuth } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import {
  accountsTable,
  db,
  sessionsTable,
  usersTable,
  verificationsTable,
} from "@workspace/db";
import { runtimeConfig } from "./config";
import { lookupAcceptableInvitation } from "./invitation-lookup";

if (!process.env.SESSION_SECRET) {
  throw new Error("SESSION_SECRET is required");
}

export const auth = betterAuth({
  secret: process.env.SESSION_SECRET,
  baseURL: `https://${runtimeConfig.appDomain}`,
  basePath: "/api/auth",
  database: drizzleAdapter(db, {
    provider: "pg",
    schema: {
      user: usersTable,
      session: sessionsTable,
      account: accountsTable,
      verification: verificationsTable,
    },
  }),
  emailAndPassword: {
    enabled: true,
    disableSignUp: false,
    minPasswordLength: 10,
  },
  hooks: {
    before: createAuthMiddleware(async (context) => {
      if (context.path !== "/sign-up/email") return;
      const body = context.body as Record<string, unknown> | undefined;
      const invitation = await lookupAcceptableInvitation(
        body?.invitationToken,
        body?.email,
      );
      if (!invitation) {
        throw new APIError("FORBIDDEN", {
          message: "A valid invitation is required to create an account",
        });
      }
    }),
  },
  advanced: {
    database: {
      generateId: false,
    },
  },
});