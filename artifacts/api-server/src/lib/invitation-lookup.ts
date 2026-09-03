import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import {
  hashInvitationToken,
  isInvitationToken,
  normalizeInvitationEmail,
} from "./invitation-token";

export type InvitationCapability = {
  invitationId: string;
  organizationId: string;
};

export async function lookupAcceptableInvitation(
  token: unknown,
  email: unknown,
): Promise<InvitationCapability | undefined> {
  if (!isInvitationToken(token) || typeof email !== "string") {
    return undefined;
  }

  const normalizedEmail = normalizeInvitationEmail(email);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(normalizedEmail)) {
    return undefined;
  }

  return db.transaction(async (tx) => {
    await tx.execute(sql.raw("set local role vid_app"));
    const result = await tx.execute<InvitationCapability>(sql`
      select
        invitation_id as "invitationId",
        organization_id as "organizationId"
      from public.lookup_acceptable_invitation(
        ${hashInvitationToken(token)},
        ${normalizedEmail}
      )
    `);
    return result.rows[0];
  });
}