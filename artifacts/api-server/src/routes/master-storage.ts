import { Router, type IRouter, type Request, type Response } from "express";
import { ArchiveVideoMasterParams, ArchiveVideoMasterResponse, GetMasterStorageStatusParams, GetMasterStorageStatusResponse, RestoreVideoMasterParams, RestoreVideoMasterResponse } from "@workspace/api-zod";
import { withTenantDb } from "../lib/tenant-db";
import { requirePermission } from "../lib/permissions";
import { MasterStorageConflictError, MasterStorageNotFoundError, MasterStorageUnavailableError, masterStatus, publicMasterOperation, requestMasterOperation } from "../lib/master-storage-operations";
import { enqueueMasterStorageDispatchWakeup } from "../lib/jobs";

const router: IRouter = Router();
function invalid(res: Response) { res.status(400).json({ error: "videoId must be a UUID." }); }
router.get("/videos/:videoId/master-status", requirePermission("videos.read"), async (req, res): Promise<void> => {
  const parsed = GetMasterStorageStatusParams.safeParse(req.params);
  if (!parsed.success) { invalid(res); return; }
  try {
    const status = await withTenantDb(req.tenant, (tx) => masterStatus(tx, req.tenant.organizationId, parsed.data.videoId));
    res.json(GetMasterStorageStatusResponse.parse(status));
  } catch (error) {
    if (error instanceof MasterStorageNotFoundError) { res.status(404).json({ error: "Video not found." }); return; }
    throw error;
  }
});
async function request(operation: "archive" | "restore", req: Request, res: Response): Promise<void> {
  const schema = operation === "archive" ? ArchiveVideoMasterParams : RestoreVideoMasterParams;
  const response = operation === "archive" ? ArchiveVideoMasterResponse : RestoreVideoMasterResponse;
  const parsed = schema.safeParse(req.params);
  if (!parsed.success) { invalid(res); return; }
  try {
    const row = await withTenantDb(req.tenant, (tx) => requestMasterOperation(tx, { organizationId: req.tenant.organizationId, userId: req.tenant.userId, videoId: parsed.data.videoId, operation, requestId: String(req.id) }));
    void enqueueMasterStorageDispatchWakeup().catch(() => req.log.warn("Master-storage dispatch wake-up failed; durable repair will retry"));
    res.status(202).json(response.parse(publicMasterOperation(row)));
  } catch (error) {
    if (error instanceof MasterStorageUnavailableError) { res.status(503).json({ code: error.code, error: "Master archive is not configured." }); return; }
    if (error instanceof MasterStorageNotFoundError) { res.status(404).json({ error: "Video not found." }); return; }
    if (error instanceof MasterStorageConflictError) { res.status(409).json({ code: error.code, error: "Video is not eligible for this master operation." }); return; }
    throw error;
  }
}
router.post("/videos/:videoId/master-archive", requirePermission("videos.update"), async (req, res): Promise<void> => request("archive", req, res));
router.post("/videos/:videoId/master-restore", requirePermission("videos.update"), async (req, res): Promise<void> => request("restore", req, res));
export default router;