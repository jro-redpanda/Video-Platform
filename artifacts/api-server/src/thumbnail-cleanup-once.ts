import { cleanupThumbnailObjects } from "./lib/thumbnail-cleanup";

const result = await cleanupThumbnailObjects();
console.log(JSON.stringify(result));