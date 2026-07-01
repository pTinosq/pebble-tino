// CLI entry for the one-time Notion OAuth login.
//   npm run auth:notion   (or: just setup-notion)
import "dotenv/config";
import { runLogin } from "./notionAuth.js";

runLogin().catch((err) => {
  console.error("Notion auth failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
