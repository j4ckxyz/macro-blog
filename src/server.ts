import { app } from "./app.ts";
import { getConfig } from "./lib/config.ts";
import { getDb } from "./db/index.ts";
import { fullBuild, hugoAvailable } from "./services/hugo.ts";
import { startScheduler } from "./services/scheduler.ts";

const cfg = getConfig();

// Ensure DB is migrated.
getDb();

const server = Bun.serve({
  port: cfg.server.port,
  hostname: cfg.server.host,
  fetch: app.fetch,
  idleTimeout: 60,
});

console.log(`✓ Macroblog listening on http://${cfg.server.host}:${server.port}`);
console.log(`  site URL: ${cfg.site.url}`);

// Run a full build on startup, then start the scheduler.
if (hugoAvailable()) {
  fullBuild()
    .then(() => console.log("✓ Initial Hugo build complete"))
    .catch((err) => console.error("Initial build failed:", err));
}
startScheduler();

function shutdown() {
  console.log("\nShutting down…");
  server.stop();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
