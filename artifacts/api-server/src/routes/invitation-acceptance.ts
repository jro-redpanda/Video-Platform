import { Router, type IRouter } from "express";
import { AcceptInvitationBody, AcceptInvitationResponse } from "@workspace/api-zod";
import { acceptInvitation, InvitationConflictError } from "../lib/invitations";
import { requireSession } from "../lib/session-auth";
import { selectionCookie } from "../lib/workspace-selection";

const router: IRouter = Router();
router.post("/invitations/accept", requireSession, async (req, res): Promise<void> => {
  const raw = req.body;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)
    || Object.keys(raw).length !== 1 || !("token" in raw)) {
    res.status(400).json({ error: "Invalid invitation" });
    return;
  }
  const { token } = AcceptInvitationBody.parse(raw);
  try {
    const accepted = await acceptInvitation(req.session!.user, token, String(req.id));
    const cookie = selectionCookie({ organizationId: accepted.organizationId, userId: req.session!.user.id, expiresAt: Date.now() + 30 * 86400000 });
    res.cookie(cookie.name, cookie.value, cookie.options);
    res.status(200).json(AcceptInvitationResponse.parse({ accepted: true }));
  } catch (error) {
    if (error instanceof InvitationConflictError) { res.status(409).json({ error: "Invitation is unavailable" }); return; }
    throw error;
  }
});
export default router;