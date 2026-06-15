import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { logger } from "hono/logger";
import { indieauth } from "./routes/indieauth.ts";
import { micropub } from "./routes/micropub.ts";
import { media } from "./routes/media.ts";
import { webmention } from "./routes/webmention.ts";
import { wellknown } from "./routes/wellknown.ts";
import { bluesky } from "./routes/oauth/bluesky.ts";
import { mastodon } from "./routes/oauth/mastodon.ts";
import { adminApi } from "./routes/admin/api.ts";
import { adminLogin } from "./routes/admin/login.ts";
import { PUBLIC_DIR } from "./services/hugo.ts";
import { UPLOADS_DIR } from "./routes/media.ts";
import { HUGO_SITE } from "./services/content.ts";
import { join } from "node:path";

const ADMIN_HTML = join(HUGO_SITE, "static", "admin", "index.html");

// Serve the admin app straight from disk so it stays reachable even when a
// Hugo build fails (the public site can be broken; admin must not be).
async function serveAdmin(c: any) {
  const f = Bun.file(ADMIN_HTML);
  if (await f.exists()) return c.html(await f.text());
  return c.text("admin UI not found", 404);
}

export function createApp(): Hono {
  const app = new Hono();

  if (process.env.MACROBLOG_QUIET !== "1") {
    app.use("*", logger());
  }

  app.get("/health", (c) => c.json({ ok: true }));

  // IndieWeb + Micropub + admin endpoints (registered before the static fallback).
  app.route("/indieauth", indieauth);
  app.route("/micropub", micropub);
  app.route("/media", media);
  app.route("/webmention", webmention);
  app.route("/.well-known", wellknown);
  app.route("/oauth/bluesky", bluesky);
  app.route("/oauth/mastodon", mastodon);
  // Admin login (no auth) must be registered before the authenticated API.
  app.route("/api/login", adminLogin);
  app.route("/api", adminApi);

  // Admin UI served by the app itself (independent of the Hugo build).
  // The wildcard lets client-side routes like /admin/timeline deep-link/refresh.
  app.get("/admin", serveAdmin);
  app.get("/admin/", serveAdmin);
  app.get("/admin/*", serveAdmin);

  // Uploaded media served from the uploads directory.
  app.use(
    "/uploads/*",
    serveStatic({
      root: relativeTo(UPLOADS_DIR),
      rewriteRequestPath: (p) => p.replace(/^\/uploads/, ""),
    }),
  );

  // Public Hugo site (catch-all). Directory requests resolve to index.html.
  app.use(
    "*",
    serveStatic({
      root: relativeTo(PUBLIC_DIR),
      rewriteRequestPath: (p) => (p.endsWith("/") ? p + "index.html" : p),
    }),
  );
  // Final fallback: try index.html for clean directory URLs without trailing slash.
  app.use(
    "*",
    serveStatic({
      root: relativeTo(PUBLIC_DIR),
      rewriteRequestPath: (p) => p.replace(/\/?$/, "/index.html"),
    }),
  );

  app.notFound((c) => c.text("Not Found", 404));
  return app;
}

// hono/bun serveStatic expects a root relative to cwd.
function relativeTo(abs: string): string {
  const cwd = process.cwd();
  if (abs.startsWith(cwd)) {
    const rel = abs.slice(cwd.length).replace(/^\/+/, "");
    return "./" + rel;
  }
  return abs;
}

export const app = createApp();
export default app;
