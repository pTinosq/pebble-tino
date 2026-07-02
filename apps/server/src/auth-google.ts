// CLI entry for the one-time Google OAuth login.
//   npm run auth:google   (or: just setup-google)
import "dotenv/config";
import { runLogin } from "./googleAuth.js";

runLogin().catch((err) => {
  console.error("Google auth failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
