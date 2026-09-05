import { cleanupThumbnailObjects } from "./lib/thumbnail-cleanup";

if (process.env.THUMBNAIL_CLEANUP_CONFIRMATION !== "authorized-object-deletion") {
  throw new Error(
    "Set THUMBNAIL_CLEANUP_CONFIRMATION=authorized-object-deletion after reviewing the target environment",
  );
}

const result = await cleanupThumbnailObjects();
console.log(JSON.stringify(result));