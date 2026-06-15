import { Hono } from "hono";
import { requireAuth } from "../../lib/middleware.ts";
import { getDb } from "../../db/index.ts";
import { getConfig, saveConfig } from "../../lib/config.ts";
import {
  createPost,
  getPostBySlug,
  updatePost,
  deletePost,
  listPosts,
  readPostFile,
  parseFrontMatter,
} from "../../services/content.ts";
import { storeUpload } from "../media.ts";
import {
  queueSyndication,
  retrySyndication,
  processPending,
  dispatchSoon,
} from "../../services/syndication.ts";
import { triggerBuild, fullBuild, getBuildStatus } from "../../services/hugo.ts";
import { isConnected, getTokenExtra, deleteToken, needsReauth } from "../../lib/tokens.ts";
import { getTimeline, refreshTimeline } from "../../services/timeline.ts";
import {
  createPage,
  listPages,
  getPageRow,
  readPage,
  updatePage,
  deletePage,
  pagePermalink,
} from "../../services/pages.ts";
import { hashPassword } from "../../lib/indieauth.ts";
import { pollReplies, pollMentions } from "../../services/reply-poller.ts";
import { replyMastodonThread } from "../../services/crosspost/mastodon.ts";
import { replyBlueskyThread } from "../../services/crosspost/bluesky.ts";
import { splitPostIntoThread } from "../../services/crosspost/thread.ts";
import { createBackup } from "../../services/backup.ts";
import { getLogsText, clearLogs } from "../../lib/logger.ts";
import { HUGO_SITE } from "../../services/content.ts";
import { readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { MicropubCreate, PostType } from "../../lib/micropub-parser.ts";
import { parseImport, isoSeconds, type ImportRecord, type ImportSource } from "../../services/import.ts";
import type { PostRow, SyndicationRow, WebmentionRow, MediaRow, SocialReplyRow } from "../../db/schema.ts";

export const adminApi = new Hono();

adminApi.use("*", requireAuth());

async function fullPost(post: PostRow) {
  const raw = await readPostFile(post);
  const { frontMatter, body } = parseFrontMatter(raw);
  const db = getDb();
  const syndications = db
    .query("SELECT platform, status, remote_url FROM syndications WHERE post_id = ?")
    .all(post.id);
  let folderName = null;
  if (post.bookmark_folder_id) {
    const f = db.query("SELECT name FROM bookmark_folders WHERE id = ?").get(post.bookmark_folder_id) as any;
    if (f) folderName = f.name;
  }
  return { ...post, content: body.trim(), front_matter: frontMatter, syndications, bookmark_folder: folderName };
}

// --- Posts ---
adminApi.get("/posts", (c) => {
  const status = c.req.query("status") ?? undefined;
  const limit = Number(c.req.query("limit") ?? 50);
  const offset = Number(c.req.query("offset") ?? 0);
  const type = c.req.query("type") ?? undefined;
  const folderId = c.req.query("folder_id") ? Number(c.req.query("folder_id")) : undefined;
  const q = c.req.query("q") ?? undefined;
  
  const db = getDb();
  const posts = listPosts({ status, limit, offset, type, folderId, q }, db);
  
  const enriched = [];
  for (const p of posts) {
    const syndications = db
      .query("SELECT platform, status, remote_url FROM syndications WHERE post_id = ?")
      .all(p.id);
    
    let folderName = null;
    if (p.bookmark_folder_id) {
      const f = db.query("SELECT name FROM bookmark_folders WHERE id = ?").get(p.bookmark_folder_id) as any;
      if (f) folderName = f.name;
    }
    enriched.push({ ...p, syndications, bookmark_folder: folderName });
  }
  return c.json({ posts: enriched });
});

adminApi.post("/posts", async (c) => {
  const b = await c.req.json();
  const create: MicropubCreate = {
    action: "create",
    type: (b.type as PostType) ?? "post",
    content: b.content ?? "",
    name: b.name ?? b.title,
    categories: b.categories ?? [],
    photos: b.photos ?? [],
    inReplyTo: b.in_reply_to,
    bookmarkOf: b.bookmark_of,
    published: b.published,
    status: b.status === "draft" ? "draft" : "published",
    syndicateTo: b.syndicate_to ?? [],
    properties: {},
  };
  if (b.bookmark_folder) (create as any).bookmark_folder = b.bookmark_folder;
  if (b.link_back !== undefined) (create as any).link_back = b.link_back === true;
  if (b.lang !== undefined) (create as any).lang = b.lang;

  // Re-derive type when caller did not force one.
  if (!b.type) {
    if (create.bookmarkOf) create.type = "bookmark";
    else if (create.inReplyTo) create.type = "reply";
    else if (create.photos.length) create.type = "photo";
    else if (create.name && create.content.length > 280) create.type = "article";
    else if (create.name) create.type = "article";
  }
  const written = await createPost(create);
  const post = getPostBySlug(written.slug)!;
  if (create.syndicateTo.length) {
    queueSyndication(post.id, create.syndicateTo);
    dispatchSoon();
  }
  triggerBuild();
  return c.json(await fullPost(post), 201);
});

adminApi.get("/posts/:slug", async (c) => {
  const post = getPostBySlug(c.req.param("slug"));
  if (!post) return c.json({ error: "not_found" }, 404);
  return c.json(await fullPost(post));
});

adminApi.put("/posts/:slug", async (c) => {
  const post = getPostBySlug(c.req.param("slug"));
  if (!post) return c.json({ error: "not_found" }, 404);
  const b = await c.req.json();
  const replace: Record<string, any[]> = {};
  if (b.content !== undefined) replace.content = [b.content];
  if (b.name !== undefined || b.title !== undefined) replace.name = [b.name ?? b.title];
  if (b.categories !== undefined) replace.category = b.categories;
  if (b.photos !== undefined) replace.photos = b.photos;
  if (b.bookmark_folder !== undefined) replace.bookmark_folder = [b.bookmark_folder];
  if (b.link_back !== undefined) replace.link_back = [b.link_back];
  if (b.lang !== undefined) replace.lang = [b.lang];

  await updatePost(post, { replace });
  if (Array.isArray(b.syndicate_to) && b.syndicate_to.length) {
    queueSyndication(post.id, b.syndicate_to);
  }
  triggerBuild();
  return c.json(await fullPost(getPostBySlug(post.slug)!));
});

adminApi.delete("/posts/:slug", async (c) => {
  const post = getPostBySlug(c.req.param("slug"));
  if (!post) return c.json({ error: "not_found" }, 404);
  await deletePost(post);
  triggerBuild();
  return c.json({ ok: true });
});

// --- Pages (custom standalone pages, e.g. /about/) ---
adminApi.get("/pages", async (c) => {
  const rows = listPages();
  const pages = [];
  for (const r of rows) {
    const p = await readPage(r);
    pages.push({ slug: r.slug, title: p.title, status: p.status, show_in_nav: p.showInNav, weight: p.weight, url: pagePermalink(r.slug) });
  }
  return c.json({ pages });
});

adminApi.post("/pages", async (c) => {
  const b = await c.req.json();
  if (!b.title || !String(b.title).trim()) return c.json({ error: "title required" }, 400);
  const row = await createPage({
    title: b.title,
    content: b.content ?? "",
    showInNav: b.show_in_nav ?? false,
    weight: Number(b.weight) || 0,
    status: b.status === "draft" ? "draft" : "published",
  });
  triggerBuild();
  return c.json({ slug: row.slug, url: pagePermalink(row.slug) }, 201);
});

adminApi.get("/pages/:slug", async (c) => {
  const row = getPageRow(c.req.param("slug"));
  if (!row) return c.json({ error: "not_found" }, 404);
  const p = await readPage(row);
  return c.json({ slug: row.slug, ...p, url: pagePermalink(row.slug) });
});

adminApi.put("/pages/:slug", async (c) => {
  const row = getPageRow(c.req.param("slug"));
  if (!row) return c.json({ error: "not_found" }, 404);
  const b = await c.req.json();
  await updatePage(row, {
    title: b.title ?? row.title ?? "",
    content: b.content ?? "",
    showInNav: b.show_in_nav ?? false,
    weight: Number(b.weight) || 0,
    status: b.status === "draft" ? "draft" : "published",
  });
  triggerBuild();
  return c.json({ ok: true });
});

adminApi.delete("/pages/:slug", async (c) => {
  const row = getPageRow(c.req.param("slug"));
  if (!row) return c.json({ error: "not_found" }, 404);
  await deletePage(row);
  triggerBuild();
  return c.json({ ok: true });
});

// --- Media ---
adminApi.get("/media", (c) => {
  const media = getDb().query("SELECT * FROM media ORDER BY created_at DESC LIMIT 200").all() as MediaRow[];
  return c.json({ media });
});

adminApi.post("/media", async (c) => {
  const form = await c.req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) return c.json({ error: "missing file" }, 400);
  try {
    const stored = await storeUpload(file);
    return c.json(stored, 201);
  } catch (err) {
    return c.json({ error: (err as Error).message }, 400);
  }
});

// --- Syndications ---
adminApi.get("/syndications", (c) => {
  const rows = getDb()
    .query("SELECT * FROM syndications ORDER BY created_at DESC LIMIT 200")
    .all() as SyndicationRow[];
  return c.json({ syndications: rows });
});

adminApi.post("/syndications/:id/retry", async (c) => {
  const ok = await retrySyndication(Number(c.req.param("id")));
  return ok ? c.json({ ok: true }) : c.json({ error: "not_found" }, 404);
});

adminApi.post("/syndications/process", async (c) => {
  const n = await processPending();
  return c.json({ processed: n });
});

// --- Webmentions ---
adminApi.get("/webmentions", (c) => {
  const status = c.req.query("status");
  const rows = status
    ? (getDb().query("SELECT * FROM webmentions WHERE status = ? ORDER BY created_at DESC").all(status) as WebmentionRow[])
    : (getDb().query("SELECT * FROM webmentions ORDER BY created_at DESC LIMIT 200").all() as WebmentionRow[]);
  return c.json({ webmentions: rows });
});

adminApi.patch("/webmentions/:id", async (c) => {
  const b = await c.req.json();
  const status = b.status;
  if (!["approved", "rejected", "pending"].includes(status)) {
    return c.json({ error: "invalid status" }, 400);
  }
  getDb().query("UPDATE webmentions SET status = ? WHERE id = ?").run(status, Number(c.req.param("id")));
  if (status === "approved") fullBuild();
  return c.json({ ok: true });
});

// --- Unified Mentions (webmentions + social replies) ---
adminApi.get("/mentions", (c) => {
  const db = getDb();
  const webmentions = db
    .query("SELECT * FROM webmentions ORDER BY created_at DESC LIMIT 200")
    .all() as WebmentionRow[];
  const social = db
    .query("SELECT * FROM social_replies ORDER BY created_at DESC LIMIT 200")
    .all() as SocialReplyRow[];
  return c.json({ webmentions, social });
});

adminApi.post("/mentions/poll", async (c) => {
  const [replies, mentions] = await Promise.all([pollReplies(), pollMentions()]);
  return c.json({ fetched: replies + mentions, replies, mentions });
});

// Reply to a Bluesky/Mastodon mention/reply. Longer replies are auto-chunked
// into a thread (same paragraph→sentence splitting as cross-posts).
adminApi.post("/mentions/:id/reply", async (c) => {
  const id = Number(c.req.param("id"));
  const { text } = await c.req.json();
  if (!text || typeof text !== "string" || !text.trim()) return c.json({ error: "text required" }, 400);
  const row = getDb().query("SELECT * FROM social_replies WHERE id = ?").get(id) as SocialReplyRow | null;
  if (!row) return c.json({ error: "not_found" }, 404);

  try {
    if (row.platform === "mastodon") {
      const chunks = splitPostIntoThread(text, 480, "", false);
      const r = await replyMastodonThread(row.remote_id, chunks);
      getDb().query("UPDATE social_replies SET replied = 1 WHERE id = ?").run(id);
      return c.json({ ok: true, url: r.url });
    }
    if (row.platform === "bluesky") {
      if (!row.remote_cid || !row.root_id || !row.root_cid) {
        return c.json({ error: "missing thread refs; re-poll mentions first" }, 400);
      }
      const chunks = splitPostIntoThread(text, 280, "", false);
      const r = await replyBlueskyThread(
        { uri: row.remote_id, cid: row.remote_cid },
        { uri: row.root_id, cid: row.root_cid },
        chunks,
      );
      getDb().query("UPDATE social_replies SET replied = 1 WHERE id = ?").run(id);
      return c.json({ ok: true, url: r.remoteUrl });
    }
    return c.json({ error: "unknown platform" }, 400);
  } catch (err) {
    return c.json({ error: (err as Error).message }, 502);
  }
});

// --- Timeline (following feed, cached server-side) ---
adminApi.get("/timeline", (c) => {
  const limit = Number(c.req.query("limit") ?? 100);
  const q = c.req.query("q") ?? undefined;
  return c.json({
    items: getTimeline(limit, q),
    bluesky: { connected: isConnected("bluesky"), needs_reauth: needsReauth("bluesky") },
    mastodon: { connected: isConnected("mastodon"), needs_reauth: needsReauth("mastodon") },
  });
});

adminApi.post("/timeline/refresh", async (c) => {
  const result = await refreshTimeline();
  return c.json(result);
});

// --- OAuth status / disconnect ---
adminApi.get("/oauth/bluesky", (c) => {
  const extra = getTokenExtra("bluesky");
  return c.json({ connected: isConnected("bluesky"), handle: extra.handle ?? null, needs_reauth: needsReauth("bluesky") });
});

adminApi.get("/oauth/mastodon", (c) => {
  const extra = getTokenExtra("mastodon");
  return c.json({ connected: isConnected("mastodon"), instance: extra.instance ?? null, needs_reauth: needsReauth("mastodon") });
});

adminApi.post("/oauth/:platform/disconnect", (c) => {
  const platform = c.req.param("platform");
  if (!["bluesky", "mastodon"].includes(platform)) return c.json({ error: "unknown platform" }, 400);
  const db = getDb();
  deleteToken(platform);
  // Drop any content cached from the now-disconnected account so a former
  // account's timeline/replies don't stick around in the admin.
  db.query("DELETE FROM timeline WHERE platform = ?").run(platform);
  db.query("DELETE FROM social_replies WHERE platform = ?").run(platform);
  return c.json({ ok: true });
});

// --- Config (non-secret) ---
function safeConfig() {
  const cfg = getConfig();
  return {
    site: cfg.site,
    server: cfg.server,
    hugo: cfg.hugo,
    crossposting: cfg.crossposting,
    webmentions: cfg.webmentions,
    feeds: cfg.feeds,
    media: cfg.media,
    microblog: cfg.microblog,
    appearance: cfg.appearance,
    navigation: cfg.navigation,
  };
}

adminApi.get("/config", (c) => c.json(safeConfig()));

adminApi.put("/config", async (c) => {
  const b = await c.req.json();
  // Never allow secrets to be set via this endpoint.
  delete b.auth;
  saveConfig(b);
  return c.json(safeConfig());
});

adminApi.put("/password", async (c) => {
  const b = await c.req.json();
  if (!b.password || String(b.password).length < 6) {
    return c.json({ error: "password must be at least 6 characters" }, 400);
  }
  const hash = await hashPassword(String(b.password));
  saveConfig({ auth: { password_hash: hash } as any });
  return c.json({ ok: true });
});

// --- Themes ---
adminApi.get("/themes", (c) => {
  const dir = join(HUGO_SITE, "themes");
  let themes: string[] = [];
  if (existsSync(dir)) {
    themes = readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  }
  return c.json({ themes, active: getConfig().hugo.theme });
});

// --- Backup ---
adminApi.get("/backup", async (c) => {
  const file = await createBackup();
  const data = await Bun.file(file).arrayBuffer();
  c.header("content-type", "application/gzip");
  c.header("content-disposition", `attachment; filename="${file.split("/").pop()}"`);
  return c.body(data);
});

// --- Logs (everything: hugo, crossposting, webmentions, requests) ---
adminApi.get("/logs", (c) => c.text(getLogsText() || "(no logs yet)"));
adminApi.delete("/logs", (c) => {
  clearLogs();
  return c.json({ ok: true });
});

// --- Hugo ---
adminApi.post("/hugo/build", async (c) => {
  await fullBuild();
  return c.json(getBuildStatus());
});

adminApi.get("/hugo/status", (c) => c.json(getBuildStatus()));

// --- Timeline replies ---
adminApi.post("/timeline/:id/reply", async (c) => {
  const id = Number(c.req.param("id"));
  const { text } = await c.req.json();
  if (!text || typeof text !== "string") return c.json({ error: "text required" }, 400);
  const row = getDb().query("SELECT * FROM timeline WHERE id = ?").get(id) as any;
  if (!row) return c.json({ error: "not_found" }, 404);

  try {
    if (row.platform === "mastodon") {
      const r = await replyMastodonThread(row.remote_id, splitPostIntoThread(text, 480, "", false));
      return c.json({ ok: true, url: r.url });
    }
    if (row.platform === "bluesky") {
      const parentUri = row.remote_id;
      const parentCid = row.remote_cid;
      const rootUri = row.root_uri || parentUri;
      const rootCid = row.root_cid || parentCid;
      if (!parentCid) {
        return c.json({ error: "missing CID; cannot reply to this Bluesky post" }, 400);
      }
      const r = await replyBlueskyThread(
        { uri: parentUri, cid: parentCid },
        { uri: rootUri, cid: rootCid },
        splitPostIntoThread(text, 280, "", false),
      );
      return c.json({ ok: true, url: r.remoteUrl });
    }
    return c.json({ error: "unknown platform" }, 400);
  } catch (err) {
    return c.json({ error: (err as Error).message }, 502);
  }
});

// --- Bookmark Folders ---
adminApi.get("/bookmarks/folders", (c) => {
  const db = getDb();
  const folders = db.query("SELECT * FROM bookmark_folders ORDER BY name ASC").all();
  return c.json({ folders });
});

adminApi.post("/bookmarks/folders", async (c) => {
  const { name } = await c.req.json();
  if (!name || !String(name).trim()) return c.json({ error: "name required" }, 400);
  const db = getDb();
  try {
    db.query("INSERT INTO bookmark_folders (name) VALUES (?)").run(name.trim());
    const folder = db.query("SELECT * FROM bookmark_folders WHERE name = ?").get(name.trim());
    return c.json(folder, 201);
  } catch (e) {
    return c.json({ error: "folder already exists" }, 400);
  }
});

adminApi.delete("/bookmarks/folders/:id", (c) => {
  const id = Number(c.req.param("id"));
  getDb().query("DELETE FROM bookmark_folders WHERE id = ?").run(id);
  return c.json({ ok: true });
});

// --- Content import (micro.blog, Twitter, RSS/Atom, WordPress, Instagram) ---
const IMPORT_SOURCES: ImportSource[] = ["microblog", "twitter", "rss", "wordpress", "instagram"];

/** Turn parsed import records into posts, skipping ones already present. */
async function ingestImport(records: ImportRecord[], db = getDb()): Promise<number> {
  let count = 0;
  for (const r of records) {
    const isoDate = isoSeconds(r.date);
    // Dedupe on the original publish second — re-running an import is a no-op.
    const exists = db.query("SELECT 1 FROM posts WHERE published_at = ?").get(isoDate);
    if (exists) continue;
    await createPost(
      {
        action: "create",
        type: r.type,
        content: r.content,
        name: r.title,
        categories: r.categories || [],
        photos: r.photos || [],
        status: "published",
        published: isoDate,
        syndicateTo: [],
        properties: {},
      },
      db,
    );
    count++;
  }
  return count;
}

adminApi.post("/import", async (c) => {
  const b = await c.req.json();
  const source = b.source as ImportSource;
  if (!IMPORT_SOURCES.includes(source)) {
    return c.json({ error: `source must be one of: ${IMPORT_SOURCES.join(", ")}` }, 400);
  }

  // Obtain the raw payload: explicit content, a parsed object, or a fetched URL.
  let raw: string | any;
  if (b.content !== undefined) {
    raw = b.content;
  } else if (b.data !== undefined || b.feed !== undefined) {
    raw = b.data ?? b.feed;
  } else if (b.url) {
    try {
      const res = await fetch(b.url, { headers: { "User-Agent": "Macroblog/1.0" } });
      if (!res.ok) return c.json({ error: `failed to fetch: ${res.status} ${res.statusText}` }, 400);
      raw = await res.text();
    } catch (e) {
      return c.json({ error: `failed to fetch: ${(e as Error).message}` }, 400);
    }
  } else {
    return c.json({ error: "provide one of: content, data, or url" }, 400);
  }

  let records: ImportRecord[];
  try {
    records = parseImport(source, raw);
  } catch (e) {
    return c.json({ error: `parse failed: ${(e as Error).message}` }, 400);
  }

  const imported = await ingestImport(records);
  triggerBuild();
  return c.json({ ok: true, source, found: records.length, imported });
});

// Back-compat alias for the original micro.blog-only endpoint.
adminApi.post("/import/microblog", async (c) => {
  const b = await c.req.json();
  let raw: any;
  if (b.feed !== undefined) raw = b.feed;
  else if (b.url) {
    try {
      const res = await fetch(b.url);
      if (!res.ok) return c.json({ error: `failed to fetch feed: ${res.statusText}` }, 400);
      raw = await res.json();
    } catch (e) {
      return c.json({ error: `failed to fetch feed: ${(e as Error).message}` }, 400);
    }
  } else return c.json({ error: "either url or feed object is required" }, 400);

  const imported = await ingestImport(parseImport("microblog", raw));
  triggerBuild();
  return c.json({ ok: true, imported });
});
