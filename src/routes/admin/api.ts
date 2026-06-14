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
} from "../../services/syndication.ts";
import { triggerBuild, fullBuild, getBuildStatus } from "../../services/hugo.ts";
import { isConnected, getTokenExtra } from "../../lib/tokens.ts";
import type { MicropubCreate, PostType } from "../../lib/micropub-parser.ts";
import type { PostRow, SyndicationRow, WebmentionRow, MediaRow } from "../../db/schema.ts";

export const adminApi = new Hono();

adminApi.use("*", requireAuth());

async function fullPost(post: PostRow) {
  const raw = await readPostFile(post);
  const { frontMatter, body } = parseFrontMatter(raw);
  const db = getDb();
  const syndications = db
    .query("SELECT platform, status, remote_url FROM syndications WHERE post_id = ?")
    .all(post.id);
  return { ...post, content: body.trim(), front_matter: frontMatter, syndications };
}

// --- Posts ---
adminApi.get("/posts", (c) => {
  const status = c.req.query("status") ?? undefined;
  const limit = Number(c.req.query("limit") ?? 50);
  const offset = Number(c.req.query("offset") ?? 0);
  const posts = listPosts({ status, limit, offset });
  return c.json({ posts });
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
  if (create.syndicateTo.length) queueSyndication(post.id, create.syndicateTo);
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

// --- OAuth status ---
adminApi.get("/oauth/bluesky", (c) => {
  const extra = getTokenExtra("bluesky");
  return c.json({ connected: isConnected("bluesky"), handle: extra.handle ?? null });
});

adminApi.get("/oauth/mastodon", (c) => {
  const extra = getTokenExtra("mastodon");
  return c.json({ connected: isConnected("mastodon"), instance: extra.instance ?? null });
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

// --- Hugo ---
adminApi.post("/hugo/build", async (c) => {
  await fullBuild();
  return c.json(getBuildStatus());
});

adminApi.get("/hugo/status", (c) => c.json(getBuildStatus()));
