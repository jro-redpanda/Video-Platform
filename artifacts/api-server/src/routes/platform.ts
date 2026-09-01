import { randomUUID } from "node:crypto";
import { Router, type IRouter } from "express";
import {
  CreateVideoBody,
  CreateVideoResponse,
  GetDashboardResponse,
  GetVideoParams,
  GetVideoResponse,
  GetWorkspaceResponse,
  ListActivityResponse,
  ListVideosQueryParams,
  ListVideosResponse,
  UpdateVideoBody,
  UpdateVideoParams,
  UpdateVideoResponse,
  UpdateWorkspaceBody,
  UpdateWorkspaceResponse,
} from "@workspace/api-zod";

const router: IRouter = Router();

let workspace = {
  id: "a23d95cc-33a5-4ca9-8220-cd2192bf86e8",
  name: "Vid",
  slug: "vid",
  plan: "Growth",
  memberCount: 14,
  storageUsedGb: 286.4,
  storageLimitGb: 500,
  playerAccent: "#6C5CE7",
  logoInitials: "NM",
};

type VideoRecord = {
  id: string;
  title: string;
  description: string;
  status: "created" | "uploading" | "processing" | "ready" | "error";
  visibility: "private" | "unlisted" | "public";
  durationSeconds: number;
  createdAt: Date;
  thumbnailColor: string;
  plays: number;
  completionRate: number;
};

const videos: VideoRecord[] = [
  {
    id: "e164a502-a6ed-41a4-98d4-f0e6bd77d392",
    title: "Launch film — Cut 04",
    description: "Final launch edit for the fall product campaign.",
    status: "ready" as const,
    visibility: "public" as const,
    durationSeconds: 143,
    createdAt: new Date("2026-08-29T14:20:00.000Z"),
    thumbnailColor: "#7457D9",
    plays: 18420,
    completionRate: 72.8,
  },
  {
    id: "a88ff359-a76b-4e55-8e34-d2f50ab81952",
    title: "Customer story: Field Notes",
    description: "A customer profile captured in Portland.",
    status: "ready" as const,
    visibility: "unlisted" as const,
    durationSeconds: 317,
    createdAt: new Date("2026-08-26T17:05:00.000Z"),
    thumbnailColor: "#D06B45",
    plays: 9327,
    completionRate: 81.2,
  },
  {
    id: "935a88ef-31c8-432c-aa51-f022632a4f45",
    title: "Product walkthrough",
    description: "Guided tour for onboarding and sales enablement.",
    status: "processing" as const,
    visibility: "private" as const,
    durationSeconds: 489,
    createdAt: new Date("2026-08-31T19:42:00.000Z"),
    thumbnailColor: "#2E9C8A",
    plays: 0,
    completionRate: 0,
  },
  {
    id: "e2673705-bf63-45e5-88ee-176044e0ff8c",
    title: "Studio session 12",
    description: "Behind-the-scenes footage from the campaign studio.",
    status: "ready" as const,
    visibility: "private" as const,
    durationSeconds: 688,
    createdAt: new Date("2026-08-22T11:12:00.000Z"),
    thumbnailColor: "#3575A8",
    plays: 6411,
    completionRate: 64.3,
  },
];

const activity = [
  { id: "1", action: "published", subject: "Launch film — Cut 04", actor: "Maya Chen", createdAt: new Date("2026-09-01T13:42:00.000Z") },
  { id: "2", action: "updated player styling for", subject: "Vid", actor: "Jason Roach", createdAt: new Date("2026-09-01T12:18:00.000Z") },
  { id: "3", action: "uploaded", subject: "Product walkthrough", actor: "Elena Torres", createdAt: new Date("2026-08-31T19:42:00.000Z") },
  { id: "4", action: "copied embed code for", subject: "Customer story: Field Notes", actor: "Maya Chen", createdAt: new Date("2026-08-31T16:09:00.000Z") },
];

router.get("/workspace", (_req, res) => {
  res.json(GetWorkspaceResponse.parse(workspace));
});

router.patch("/workspace", (req, res) => {
  const update = UpdateWorkspaceBody.parse(req.body);
  workspace = { ...workspace, ...update };
  res.json(UpdateWorkspaceResponse.parse(workspace));
});

router.get("/dashboard", (_req, res) => {
  res.json(GetDashboardResponse.parse({
    totalVideos: 48,
    totalPlays: 34192,
    watchTimeHours: 1287.6,
    completionRate: 74.2,
    playsTrend: [
      { date: "Aug 26", plays: 3820 }, { date: "Aug 27", plays: 4260 },
      { date: "Aug 28", plays: 3980 }, { date: "Aug 29", plays: 5410 },
      { date: "Aug 30", plays: 4890 }, { date: "Aug 31", plays: 5720 },
      { date: "Sep 1", plays: 6112 },
    ],
    topVideos: videos.filter((video) => video.plays > 0).slice(0, 3),
  }));
});

router.get("/videos", (req, res) => {
  const query = ListVideosQueryParams.parse(req.query);
  const search = query.search?.toLowerCase();
  const result = videos.filter((video) =>
    (!search || video.title.toLowerCase().includes(search)) &&
    (!query.status || video.status === query.status),
  );
  res.json(ListVideosResponse.parse(result));
});

router.post("/videos", (req, res) => {
  const input = CreateVideoBody.parse(req.body);
  const video = {
    id: randomUUID(),
    title: input.title,
    description: input.description ?? "",
    status: "uploading" as const,
    visibility: "private" as const,
    durationSeconds: 0,
    createdAt: new Date(),
    thumbnailColor: "#5B5BD6",
    plays: 0,
    completionRate: 0,
  };
  videos.unshift(video);
  res.status(201).json(CreateVideoResponse.parse(video));
});

router.get("/videos/:videoId", (req, res) => {
  const { videoId } = GetVideoParams.parse(req.params);
  const video = videos.find((item) => item.id === videoId);
  if (!video) {
    res.status(404).json({ error: "Video not found" });
    return;
  }
  res.json(GetVideoResponse.parse(video));
});

router.patch("/videos/:videoId", (req, res) => {
  const { videoId } = UpdateVideoParams.parse(req.params);
  const update = UpdateVideoBody.parse(req.body);
  const index = videos.findIndex((item) => item.id === videoId);
  if (index < 0) {
    res.status(404).json({ error: "Video not found" });
    return;
  }
  videos[index] = { ...videos[index], ...update };
  res.json(UpdateVideoResponse.parse(videos[index]));
});

router.get("/activity", (_req, res) => {
  res.json(ListActivityResponse.parse(activity));
});

export default router;