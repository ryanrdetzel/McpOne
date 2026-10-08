import { constants } from "node:fs";
import { chmod, copyFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const target = new URL("apps/worker/.dev.vars", root);
try {
  await copyFile(
    new URL("apps/worker/.dev.vars.example", root),
    target,
    constants.COPYFILE_EXCL,
  );
  await chmod(target, 0o600);
  console.log(
    "Created local Worker bindings; existing bindings are never overwritten.",
  );
} catch (error) {
  if (error.code !== "EEXIST") throw error;
  console.log("Kept existing local Worker bindings.");
}
