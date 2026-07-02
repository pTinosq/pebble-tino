// CLI entry for the one-time Slack OAuth login.
//   npm run auth:slack   (or: just setup-slack)
import "dotenv/config";
import { runLogin } from "./slackAuth.js";

runLogin().catch((err) => {
  console.error("Slack auth failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
