import { rm } from "node:fs/promises";

// React Router uses this manifest during prerendering; it is not a public asset.
// Remove it only after that build finishes, before the lifecycle snapshot.
await rm(new URL("../apps/web/build/client/.vite/", import.meta.url), {
  recursive: true,
  force: true,
});
