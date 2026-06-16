import { existsSync } from "node:fs";
import { installConsoleCapture } from "./lib/logger.ts";
// Capture all console output into the in-memory log buffer (admin Logs page).
installConsoleCapture();
import { app } from "./app.ts";
import { getConfig, saveConfig, reloadConfig, CONFIG_PATH, type MacroblogConfig } from "./lib/config.ts";
import { getDb } from "./db/index.ts";
import { hashPassword, randomToken } from "./lib/indieauth.ts";
import { fullBuild, hugoAvailable } from "./services/hugo.ts";
import { startScheduler } from "./services/scheduler.ts";

/**
 * First-run provisioning. Lets a container (or a fresh install) come up with
 * zero manual steps when env vars are supplied:
 *   - creates macroblog.config.yaml from defaults + MACROBLOG_SITE_* env vars
 *   - generates a session secret if missing
 *   - sets the admin password from MACROBLOG_ADMIN_PASSWORD if not yet set
 */
async function bootstrap(): Promise<MacroblogConfig> {
  let cfg = getConfig();
  const patch: any = {};

  if (!existsSync(CONFIG_PATH)) {
    patch.site = {
      url: process.env.MACROBLOG_SITE_URL || cfg.site.url,
      title: process.env.MACROBLOG_SITE_TITLE || cfg.site.title,
      author: process.env.MACROBLOG_AUTHOR || cfg.site.author,
      username: process.env.MACROBLOG_USERNAME || cfg.site.username,
      description: process.env.MACROBLOG_DESCRIPTION || cfg.site.description,
    };
  } else if (process.env.MACROBLOG_SITE_URL && process.env.MACROBLOG_SITE_URL !== cfg.site.url) {
    // Domain migration: MACROBLOG_SITE_URL always wins, even on an existing
    // install. Post permalinks are date+slug based (see config.toml
    // [permalinks]) so the public path of every post is unchanged — only the
    // host moves. Change the env var (and your DNS) and restart to migrate.
    console.log(`[bootstrap] migrating site URL: ${cfg.site.url} → ${process.env.MACROBLOG_SITE_URL}`);
    patch.site = { ...(patch.site || {}), url: process.env.MACROBLOG_SITE_URL };
  }
  if (!cfg.auth.session_secret) {
    patch.auth = { ...(patch.auth || {}), session_secret: randomToken(48) };
  }
  if (!cfg.auth.password_hash && process.env.MACROBLOG_ADMIN_PASSWORD) {
    patch.auth = { ...(patch.auth || {}), password_hash: await hashPassword(process.env.MACROBLOG_ADMIN_PASSWORD) };
  }
  if (Object.keys(patch).length) {
    saveConfig(patch);
    cfg = reloadConfig();
  }
  return cfg;
}

const cfg = await bootstrap();

// Ensure DB is migrated.
getDb();

// Host/port may be overridden by env (Docker binds 0.0.0.0; mapping controls exposure).
const host = process.env.MACROBLOG_HOST || cfg.server.host;
const port = Number(process.env.PORT || process.env.MACROBLOG_PORT || cfg.server.port);

const server = Bun.serve({
  port,
  hostname: host,
  fetch: app.fetch,
  idleTimeout: 60,
});

console.log(`✓ Macroblog listening on http://${host}:${server.port}`);
console.log(`  site URL: ${cfg.site.url}`);
if (!cfg.auth.password_hash) {
  console.warn("  ⚠ No admin password set. Set MACROBLOG_ADMIN_PASSWORD or run: bun run macroblog --set-password");
}

// Run a full build on startup, then start the scheduler.
if (hugoAvailable()) {
  fullBuild()
    .then(() => console.log("✓ Initial Hugo build complete"))
    .catch((err) =>
      console.error(
        "⚠ Initial Hugo build FAILED — the public site will 404 until this is fixed " +
          "(admin stays reachable at /admin/). Cause:",
        err,
      ),
    );
} else {
  console.warn(
    "⚠ Hugo site directory not found (MACROBLOG_HUGO_SITE) — the public site can't be built and will 404.",
  );
}
startScheduler();

function shutdown() {
  console.log("\nShutting down…");
  server.stop();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
