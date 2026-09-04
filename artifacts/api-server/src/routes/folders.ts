import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { Router, type IRouter } from "express";
import {
  foldersTable,
  videosTable,
} from "@workspace/db";
import {
  CreateFolderBody,
  CreateFolderResponse,
  DeleteFolderParams,
  GetFolderParams,
  GetFolderResponse,
  ListFoldersQueryParams,
  ListFoldersResponse,
  UpdateFolderBody,
  UpdateFolderParams,
  UpdateFolderResponse,
} from "@workspace/api-zod";
import { requirePermission } from "../lib/permissions";
import { requireCreateAccess } from "../lib/entitlements";
import { withTenantDb, type TenantTransaction } from "../lib/tenant-db";
import { auditDiff, auditUser, writeAuditEvent } from "../lib/audit";

const router: IRouter = Router();
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const maxFolderDepth = 20;

type FolderRow = typeof foldersTable.$inferSelect;

function parseFolderLocation(value: string): string | null | undefined {
  if (value === "root") return null;
  return uuidPattern.test(value) ? value : undefined;
}

function normalizeName(value: string): string | undefined {
  const name = value.trim();
  return name.length >= 1 && name.length <= 120 ? name : undefined;
}

async function loadFolders(tx: TenantTransaction, organizationId: string) {
  return tx.select().from(foldersTable)
    .where(eq(foldersTable.organizationId, organizationId))
    .orderBy(asc(foldersTable.name), asc(foldersTable.id));
}

function ancestorsFor(folder: FolderRow, byId: Map<string, FolderRow>) {
  const ancestors: Array<{ id: string; name: string }> = [];
  const visited = new Set<string>([folder.id]);
  let parentId = folder.parentId;
  while (parentId) {
    if (visited.has(parentId)) throw new Error("Folder hierarchy contains a cycle");
    visited.add(parentId);
    const parent = byId.get(parentId);
    if (!parent) throw new Error("Folder hierarchy has a missing parent");
    ancestors.unshift({ id: parent.id, name: parent.name });
    parentId = parent.parentId;
  }
  return ancestors;
}

function subtreeHeight(folderId: string, folders: FolderRow[]) {
  const children = new Map<string, string[]>();
  for (const folder of folders) {
    if (!folder.parentId) continue;
    children.set(folder.parentId, [...(children.get(folder.parentId) ?? []), folder.id]);
  }
  const walk = (id: string, path: Set<string>): number => {
    if (path.has(id)) throw new Error("Folder hierarchy contains a cycle");
    const nextPath = new Set(path).add(id);
    return Math.max(0, ...(children.get(id) ?? []).map((childId) => 1 + walk(childId, nextPath)));
  };
  return walk(folderId, new Set());
}

async function serializeFolders(tx: TenantTransaction, organizationId: string, rows: FolderRow[]) {
  if (rows.length === 0) return [];
  const folderIds = rows.map(({ id }) => id);
  const childCountRows = await tx.select({
    parentId: foldersTable.parentId,
    count: sql<number>`count(*)::int`,
  }).from(foldersTable)
    .where(and(
      eq(foldersTable.organizationId, organizationId),
      inArray(foldersTable.parentId, folderIds),
    ))
    .groupBy(foldersTable.parentId);
  const childCounts = new Map(childCountRows.map(({ parentId, count }) => [parentId, count]));
  const videoCounts = await tx.select({
    folderId: videosTable.folderId,
    count: sql<number>`count(*)::int`,
  }).from(videosTable)
    .where(and(
      eq(videosTable.organizationId, organizationId),
      inArray(videosTable.folderId, folderIds),
    ))
    .groupBy(videosTable.folderId);
  const videosByFolder = new Map(videoCounts.map(({ folderId, count }) => [folderId, count]));
  return rows.map((folder) => ({
    ...folder,
    childFolderCount: childCounts.get(folder.id) ?? 0,
    videoCount: videosByFolder.get(folder.id) ?? 0,
  }));
}

async function detailFor(tx: TenantTransaction, organizationId: string, folder: FolderRow) {
  const folders = await loadFolders(tx, organizationId);
  const [serialized] = await serializeFolders(tx, organizationId, [folder]);
  return { ...serialized!, ancestors: ancestorsFor(folder, new Map(folders.map((row) => [row.id, row]))) };
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null &&
    ("code" in error && (error as { code?: string }).code === "23505" ||
      "cause" in error && isUniqueViolation((error as { cause?: unknown }).cause));
}

router.get("/folders", requirePermission("videos.read"), async (req, res): Promise<void> => {
  const parsed = ListFoldersQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid folder query parameters." });
    return;
  }
  const parentId = parseFolderLocation(parsed.data.parentId);
  if (parentId === undefined) {
    res.status(400).json({ error: "parentId must be root or a folder UUID." });
    return;
  }
  const result = await withTenantDb(req.tenant, async (tx) => {
    if (parentId) {
      const [parent] = await tx.select({ id: foldersTable.id }).from(foldersTable).where(and(
        eq(foldersTable.organizationId, req.tenant.organizationId),
        eq(foldersTable.id, parentId),
      )).limit(1);
      if (!parent) return undefined;
    }
    const rows = await tx.select().from(foldersTable).where(and(
      eq(foldersTable.organizationId, req.tenant.organizationId),
      parentId ? eq(foldersTable.parentId, parentId) : sql`${foldersTable.parentId} is null`,
    )).orderBy(asc(foldersTable.name), asc(foldersTable.id));
    return serializeFolders(tx, req.tenant.organizationId, rows);
  });
  if (!result) {
    res.status(404).json({ error: "Folder not found" });
    return;
  }
  res.json(ListFoldersResponse.parse(result));
});

router.post("/folders", requirePermission("videos.update"), requireCreateAccess, async (req, res): Promise<void> => {
  const parsed = CreateFolderBody.safeParse(req.body);
  const name = parsed.success ? normalizeName(parsed.data.name) : undefined;
  if (!parsed.success || !name) {
    res.status(400).json({ error: "Folder name must be 1-120 characters after trimming." });
    return;
  }
  const parentId = parsed.data.parentId ?? null;
  if (parentId && !uuidPattern.test(parentId)) {
    res.status(400).json({ error: "parentId must be a folder UUID or null." });
    return;
  }
  try {
    const folder = await withTenantDb(req.tenant, async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${req.tenant.organizationId}))`);
      const folders = await loadFolders(tx, req.tenant.organizationId);
      if (parentId) {
        const parent = folders.find(({ id }) => id === parentId);
        if (!parent) return undefined;
        if (ancestorsFor(parent, new Map(folders.map((row) => [row.id, row]))).length + 2 > maxFolderDepth) {
          throw new FolderConflictError("Folder depth cannot exceed 20.");
        }
      }
      const [created] = await tx.insert(foldersTable).values({
        organizationId: req.tenant.organizationId, parentId, name,
      }).returning();
      await writeAuditEvent(tx, {
        organizationId: req.tenant.organizationId, actor: auditUser(req.tenant.userId),
        action: "folder.created", category: "content",
        subject: { type: "folder", id: created!.id, label: name },
        afterState: { name, parentId }, requestId: String(req.id),
      });
      return detailFor(tx, req.tenant.organizationId, created!);
    });
    if (!folder) {
      res.status(404).json({ error: "Parent folder not found" });
      return;
    }
    res.status(201).json(CreateFolderResponse.parse(folder));
  } catch (error) {
    if (isUniqueViolation(error)) {
      res.status(409).json({ error: "A folder with this name already exists in that location." });
      return;
    }
    if (error instanceof FolderConflictError) {
      res.status(409).json({ error: error.message });
      return;
    }
    throw error;
  }
});

router.get("/folders/:folderId", requirePermission("videos.read"), async (req, res): Promise<void> => {
  const parsed = GetFolderParams.safeParse(req.params);
  if (!parsed.success || !uuidPattern.test(parsed.data.folderId)) {
    res.status(400).json({ error: "Invalid folder ID." });
    return;
  }
  const folder = await withTenantDb(req.tenant, async (tx) => {
    const [row] = await tx.select().from(foldersTable).where(and(
      eq(foldersTable.organizationId, req.tenant.organizationId),
      eq(foldersTable.id, parsed.data.folderId),
    )).limit(1);
    return row ? detailFor(tx, req.tenant.organizationId, row) : undefined;
  });
  if (!folder) {
    res.status(404).json({ error: "Folder not found" });
    return;
  }
  res.json(GetFolderResponse.parse(folder));
});

router.patch("/folders/:folderId", requirePermission("videos.update"), async (req, res): Promise<void> => {
  const params = UpdateFolderParams.safeParse(req.params);
  const parsed = UpdateFolderBody.safeParse(req.body);
  if (!params.success || !uuidPattern.test(params.data.folderId) || !parsed.success) {
    res.status(400).json({ error: "Invalid folder update." });
    return;
  }
  if (parsed.data.name === undefined && parsed.data.parentId === undefined) {
    res.status(400).json({ error: "At least one folder field must be supplied." });
    return;
  }
  const name = parsed.data.name === undefined ? undefined : normalizeName(parsed.data.name);
  if (parsed.data.name !== undefined && !name) {
    res.status(400).json({ error: "Folder name must be 1-120 characters after trimming." });
    return;
  }
  if (parsed.data.parentId && !uuidPattern.test(parsed.data.parentId)) {
    res.status(400).json({ error: "parentId must be a folder UUID or null." });
    return;
  }
  try {
    const result = await withTenantDb(req.tenant, async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${req.tenant.organizationId}))`);
      const folders = await loadFolders(tx, req.tenant.organizationId);
      const current = folders.find(({ id }) => id === params.data.folderId);
      if (!current) return undefined;
      const destination = parsed.data.parentId === undefined ? current.parentId : parsed.data.parentId;
      if (destination === current.id) throw new FolderConflictError("A folder cannot be its own parent.");
      const byId = new Map(folders.map((row) => [row.id, row]));
      if (destination) {
        const parent = byId.get(destination);
        if (!parent) throw new FolderTargetNotFoundError();
        let cursor: FolderRow | undefined = parent;
        while (cursor) {
          if (cursor.id === current.id) throw new FolderConflictError("A folder cannot be moved into its descendant.");
          cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined;
        }
        const parentDepth = ancestorsFor(parent, byId).length + 1;
        if (parentDepth + 1 + subtreeHeight(current.id, folders) > maxFolderDepth) {
          throw new FolderConflictError("Moving this folder would exceed the maximum depth of 20.");
        }
      } else if (1 + subtreeHeight(current.id, folders) > maxFolderDepth) {
        throw new FolderConflictError("Moving this folder would exceed the maximum depth of 20.");
      }
      const [updated] = await tx.update(foldersTable).set({
        ...(name !== undefined ? { name } : {}),
        ...(parsed.data.parentId !== undefined ? { parentId: parsed.data.parentId } : {}),
        updatedAt: new Date(),
      }).where(and(
        eq(foldersTable.organizationId, req.tenant.organizationId),
        eq(foldersTable.id, current.id),
      )).returning();
      await writeAuditEvent(tx, {
        organizationId: req.tenant.organizationId, actor: auditUser(req.tenant.userId),
        action: parsed.data.parentId !== undefined ? "folder.moved" : "folder.renamed",
        category: "content", subject: { type: "folder", id: current.id, label: updated!.name },
        ...auditDiff({ name: current.name, parentId: current.parentId }, { name: updated!.name, parentId: updated!.parentId }),
        requestId: String(req.id),
      });
      return detailFor(tx, req.tenant.organizationId, updated!);
    });
    if (!result) {
      res.status(404).json({ error: "Folder not found" });
      return;
    }
    res.json(UpdateFolderResponse.parse(result));
  } catch (error) {
    if (error instanceof FolderTargetNotFoundError) {
      res.status(404).json({ error: "Parent folder not found" });
      return;
    }
    if (error instanceof FolderConflictError || isUniqueViolation(error)) {
      res.status(409).json({ error: error instanceof FolderConflictError
        ? error.message : "A folder with this name already exists in that location." });
      return;
    }
    throw error;
  }
});

router.delete("/folders/:folderId", requirePermission("videos.update"), async (req, res): Promise<void> => {
  const params = DeleteFolderParams.safeParse(req.params);
  if (!params.success || !uuidPattern.test(params.data.folderId)) {
    res.status(400).json({ error: "Invalid folder ID." });
    return;
  }
  const outcome = await withTenantDb(req.tenant, async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${req.tenant.organizationId}))`);
    const [folder] = await tx.select().from(foldersTable).where(and(
      eq(foldersTable.organizationId, req.tenant.organizationId),
      eq(foldersTable.id, params.data.folderId),
    )).limit(1);
    if (!folder) return "missing" as const;
    const [contents] = await tx.select({
      childCount: sql<number>`(select count(*)::int from ${foldersTable} child where child.organization_id = ${req.tenant.organizationId} and child.parent_id = ${folder.id})`,
      videoCount: sql<number>`(select count(*)::int from ${videosTable} video where video.organization_id = ${req.tenant.organizationId} and video.folder_id = ${folder.id})`,
    }).from(foldersTable).where(and(
      eq(foldersTable.organizationId, req.tenant.organizationId),
      eq(foldersTable.id, folder.id),
    )).limit(1);
    if (contents!.childCount || contents!.videoCount) return "not-empty" as const;
    await writeAuditEvent(tx, {
      organizationId: req.tenant.organizationId, actor: auditUser(req.tenant.userId),
      action: "folder.deleted", category: "content",
      subject: { type: "folder", id: folder.id, label: folder.name },
      beforeState: { name: folder.name, parentId: folder.parentId }, requestId: String(req.id),
    });
    await tx.delete(foldersTable).where(and(
      eq(foldersTable.organizationId, req.tenant.organizationId),
      eq(foldersTable.id, folder.id),
    ));
    return "deleted" as const;
  });
  if (outcome === "missing") {
    res.status(404).json({ error: "Folder not found" });
    return;
  }
  if (outcome === "not-empty") {
    res.status(409).json({ error: "Only empty folders can be deleted." });
    return;
  }
  res.sendStatus(204);
});

class FolderConflictError extends Error {}
class FolderTargetNotFoundError extends Error {}

export default router;