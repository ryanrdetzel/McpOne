import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";

for (const name of ["production.secrets.json", "preview.secrets.json"]) {
  try {
    await writeFile(
      new URL(`../${name}`, import.meta.url),
      `${JSON.stringify({ BETTER_AUTH_SECRET: randomBytes(48).toString("base64url") }, null, 2)}\n`,
      { flag: "wx", mode: 0o600 },
    );
    console.log(
      `Created ${name} with a distinct auth secret; values are not printed.`,
    );
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    console.log(`Kept existing ${name}; secrets are never overwritten.`);
  }
}
