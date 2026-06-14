import { Hono } from "hono";
import { getConfig } from "../lib/config.ts";
import { requireAuth } from "../lib/middleware.ts";
import { parseJson, parseForm, type MicropubCreate } from "../lib/micropub-parser.ts";
import {
  createPost,
  updatePost,
  deletePost,
  getPostByPermalink,
  readPostFile,
  parseFrontMatter,
} from "../services/content.ts";
import { queueSyndication, listSyndicateTargets } from "../services/syndication.ts";
import { triggerBuild } from "../services/hugo.ts";
import { getDb } from "../db/index.ts";
import type { PostRow } from "../db/schema.ts";

export const micropub = new Hono();

// GET /micropub — capabilities, source query.
micropub.get("/", requireAuth(), (c) => {
  const cfg = getConfig();
  const q = c.req.query("q");

  if (q === "config" || q === "syndicate-to") {
    const syndicateTo = listSyndicateTargets();
    if (q === "syndicate-to") return c.json({ "syndicate-to": syndicateTo });
    return c.json({
      "media-endpoint": `${cfg.site.url.replace(/\/+$/, "")}/media`,
      "syndicate-to": syndicateTo,
      "post-types": [
        { type: "note", name: "Note" },
        { type: "article", name: "Article" },
        { type: "photo", name: "Photo" },
        { type: "bookmark", name: "Bookmark" },
      ],
    });
  }

  if (q === "source") {
    const url = c.req.query("url");
    if (!url) return c.json({ error: "invalid_request" }, 400);
    const post = getPostByPermalink(url);
    if (!post) return c.json({ error: "not_found" }, 404);
    return sourceResponse(c, post);
  }

  return c.json({});
});

async function sourceResponse(c: any, post: PostRow) {
  const raw = await readPostFile(post);
  const { frontMatter, body } = parseFrontMatter(raw);
  const properties: Record<string, any[]> = { content: [body.trim()] };
  if (frontMatter.title) properties.name = [frontMatter.title];
  if (Array.isArray(frontMatter.categories) && frontMatter.categories.length) {
    properties.category = frontMatter.categories;
  }
  if (frontMatter.date) properties.published = [frontMatter.date];
  if (frontMatter.reply_to_url) properties["in-reply-to"] = [frontMatter.reply_to_url];
  if (frontMatter.bookmark_url) properties["bookmark-of"] = [frontMatter.bookmark_url];
  return c.json({ type: ["h-entry"], properties });
}

// POST /micropub — create / update / delete.
micropub.post("/", requireAuth(), async (c) => {
  const contentType = c.req.header("content-type") ?? "";
  let req;
  if (contentType.includes("application/json")) {
    req = parseJson(await c.req.json());
  } else {
    const params = new URLSearchParams();
    const body = await c.req.parseBody();
    for (const [k, v] of Object.entries(body)) {
      if (Array.isArray(v)) for (const item of v) params.append(k, String(item));
      else params.append(k, String(v));
    }
    req = parseForm(params);
  }

  const token = c.get("token");

  if (req.action === "delete") {
    const post = getPostByPermalink(req.url);
    if (!post) return c.json({ error: "not_found" }, 404);
    await deletePost(post);
    triggerBuild();
    return c.body(null, 204);
  }

  if (req.action === "update") {
    const post = getPostByPermalink(req.url);
    if (!post) return c.json({ error: "not_found" }, 404);
    const result = await updatePost(post, {
      replace: req.replace,
      add: req.add,
      delete: req.delete,
    });
    triggerBuild();
    c.header("Location", result.permalink);
    return c.body(null, 200);
  }

  // create
  const create = req as MicropubCreate;
  const written = await createPost(create);
  const db = getDb();
  const post = db.query("SELECT * FROM posts WHERE slug = ?").get(written.slug) as PostRow;

  if (create.syndicateTo.length) {
    queueSyndication(post.id, create.syndicateTo, db);
  }

  triggerBuild();

  c.header("Location", written.permalink);
  return c.body(null, 201);
});
