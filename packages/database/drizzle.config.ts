import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: ["../schema/src/db.ts", "../schema/src/auth.ts"],
  // Candidate SQL only: review and promote changes to a new ordered migration.
  // Wrangler applies migrations/, which generation must never overwrite.
  out: "./generated",
  dialect: "sqlite",
});
