import { and, eq } from "drizzle-orm";
import { Router, type IRouter } from "express";
import { db, membershipsTable, organizationsTable } from "@workspace/db";
import {
  ListWorkspacesResponse,
  SelectWorkspaceBody,
  SelectWorkspaceResponse,
} from "@workspace/api-zod";
import { requireSession } from "../lib/session-auth";
import { selectionCookie } from "../lib/workspace-selection";
import { resolveWorkspaceForRequest } from "../lib/tenant-context";

const router: IRouter = Router();
router.get("/workspaces", requireSession, async (req, res): Promise<void> => {
  const resolved = await resolveWorkspaceForRequest(req, req.session!.user.id);
  res.json(ListWorkspacesResponse.parse(resolved.workspaces.map((workspace) => ({
    ...workspace,
    current: workspace.id === resolved.current?.id,
  }))));
});
router.post("/workspaces/select", requireSession, async (req, res): Promise<void> => {
  const raw = req.body;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)
    || Object.keys(raw).length !== 1
    || !Object.keys(raw).every((key) => key === "id" || key === "slug")) {
    res.status(400).json({ error: "A workspace selector is required" }); return;
  }
  const parsed = SelectWorkspaceBody.safeParse(raw);
  if (!parsed.success) {
    res.status(400).json({ error: "A valid workspace selector is required" }); return;
  }
  const selector = parsed.data;
  const conditions = [eq(membershipsTable.userId, req.session!.user.id), eq(membershipsTable.status, "active"), eq(organizationsTable.status, "active")];
  if ("id" in selector) conditions.push(eq(organizationsTable.id, selector.id));
  else conditions.push(eq(organizationsTable.slug, selector.slug));
  const [workspace] = await db.select({ id: organizationsTable.id, name: organizationsTable.name, slug: organizationsTable.slug })
    .from(membershipsTable).innerJoin(organizationsTable, eq(organizationsTable.id, membershipsTable.organizationId))
    .where(and(...conditions)).limit(1);
  if (!workspace) { res.status(403).json({ error: "Workspace selection unavailable" }); return; }
  const cookie = selectionCookie({ organizationId: workspace.id, userId: req.session!.user.id, expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000 });
  res.cookie(cookie.name, cookie.value, cookie.options);
  res.json(SelectWorkspaceResponse.parse({ ...workspace, current: true }));
});
export default router;