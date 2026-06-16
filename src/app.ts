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
import { PUBLIC_DIR, getBuildStatus, hugoAvailable } from "./services/hugo.ts";
import { UPLOADS_DIR } from "./routes/media.ts";
import { HUGO_SITE } from "./services/content.ts";
import { join } from "node:path";
import { existsSync } from "node:fs";

const ADMIN_HTML = join(HUGO_SITE, "static", "admin", "index.html");

function escapeHtml(s: string): string {
  return s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]!));
}

/**
 * When the Hugo build hasn't produced public/index.html, EVERY public URL would
 * otherwise 404 with a bare "Not Found", which is impossible to diagnose. The
 * admin (served from disk) keeps working, so point people there and show the
 * actual last build error so the cause is obvious.
 */
function siteNotBuiltPage(): string {
  const s = getBuildStatus();
  const reason = !hugoAvailable()
    ? "The Hugo site directory wasn't found, so the public site can't be built."
    : s.lastSuccess
      ? "The site output is missing even though the last build reported success — try rebuilding."
      : "The last Hugo build failed, so the public site hasn't been generated yet.";
  const log = s.log ? `<h2>Last build output</h2><pre>${escapeHtml(s.log)}</pre>` : "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Site not built yet — Macroblog</title>
<style>body{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;max-width:46rem;margin:3rem auto;padding:0 1.25rem;color:#111;line-height:1.55}
h1{font-size:1.4rem}a{color:#1a56db}pre{white-space:pre-wrap;word-break:break-word;background:#f6f7f9;border:1px solid #e4e6ea;border-radius:8px;padding:12px;font-size:12.5px;max-height:50vh;overflow:auto}
.card{background:#fff7f0;border:1px solid #f0d8c0;border-radius:10px;padding:14px 16px;margin:1rem 0}</style></head>
<body><h1>Your site isn't built yet</h1>
<div class="card">${escapeHtml(reason)}</div>
<p>Open the <a href="/admin/">admin dashboard</a> (it works even when the build is broken), then
<strong>Settings → Rebuild site</strong>. If it keeps failing, the build output below usually says why
(a missing <code>hugo</code> binary, a theme error, or a bad post).</p>
${log}
</body></html>`;
}

// Serve the admin app straight from disk so it stays reachable even when a
// Hugo build fails (the public site can be broken; admin must not be).
async function serveAdmin(c: any) {
  const f = Bun.file(ADMIN_HTML);
  if (await f.exists()) return c.html(await f.text());
  return c.text("admin UI not found", 404);
}

/**
 * Permissive CORS for the open, standards-based endpoints (Micropub, IndieAuth,
 * media, discovery). Self-hosted Macroblog is meant to interoperate with any
 * Micropub/IndieAuth writing client — including browser-based ones (Quill, etc.)
 * — which require CORS to talk to the endpoint cross-origin. These endpoints are
 * still bearer-protected, so allowing any origin is safe.
 */
async function openCors(c: any, next: any) {
  const origin = c.req.header("origin") || "*";
  c.header("Access-Control-Allow-Origin", origin);
  c.header("Vary", "Origin");
  c.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  c.header("Access-Control-Allow-Headers", "Authorization, Content-Type");
  c.header("Access-Control-Expose-Headers", "Location, Link");
  c.header("Access-Control-Max-Age", "86400");
  if (c.req.method === "OPTIONS") return c.body(null, 204);
  await next();
}

export function createApp(): Hono {
  const app = new Hono();

  if (process.env.MACROBLOG_QUIET !== "1") {
    app.use("*", logger());
  }

  // Cross-origin access for the interoperable IndieWeb endpoints.
  for (const p of ["/micropub/*", "/micropub", "/media/*", "/media", "/indieauth/*", "/.well-known/*"]) {
    app.use(p, openCors);
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

  app.notFound((c) => {
    // No successful build → public/index.html is absent and every public URL
    // 404s. Return a self-diagnosing page (with the build error) instead of a
    // bare "Not Found"; the admin stays reachable at /admin/.
    if (!existsSync(join(PUBLIC_DIR, "index.html"))) {
      return c.html(siteNotBuiltPage(), 503);
    }
    return c.text("Not Found", 404);
  });
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
