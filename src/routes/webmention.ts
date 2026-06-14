import { Hono } from "hono";
import { mf2 } from "microformats-parser";
import { getConfig } from "../lib/config.ts";
import { getDb } from "../db/index.ts";
import { getPostByPermalink } from "../services/content.ts";
import { scheduleFullBuild } from "../services/hugo.ts";

export const webmention = new Hono();

function sameDomain(url: string): boolean {
  try {
    const target = new URL(url);
    const site = new URL(getConfig().site.url);
    return target.hostname === site.hostname;
  } catch {
    return false;
  }
}

webmention.post("/", async (c) => {
  const cfg = getConfig();
  if (!cfg.webmentions.receive) return c.json({ error: "webmentions disabled" }, 400);

  const body = await c.req.parseBody();
  const source = typeof body.source === "string" ? body.source : "";
  const target = typeof body.target === "string" ? body.target : "";

  if (!isValidUrl(source) || !isValidUrl(target)) {
    return c.json({ error: "invalid_request", error_description: "source and target must be valid URLs" }, 400);
  }
  if (source === target) {
    return c.json({ error: "invalid_request", error_description: "source and target identical" }, 400);
  }
  if (!sameDomain(target)) {
    return c.json({ error: "invalid_request", error_description: "target not on this domain" }, 400);
  }

  // Accept and verify asynchronously.
  queueMicrotask(() => verifyWebmention(source, target).catch((e) => console.warn("[webmention]", e)));
  return c.body("Accepted", 202);
});

function isValidUrl(s: string): boolean {
  try {
    const u = new URL(s);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Fetch the source, confirm it links to target, parse microformats2, and
 * persist the webmention.
 */
export async function verifyWebmention(
  source: string,
  target: string,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  const cfg = getConfig();
  const res = await fetchImpl(source, { headers: { accept: "text/html" } });
  if (!res.ok) return false;
  const html = await res.text();

  if (!html.includes(target)) {
    // Source does not link back; remove any prior mention.
    getDb().query("DELETE FROM webmentions WHERE source = ? AND target = ?").run(source, target);
    return false;
  }

  const parsed = parseSource(html, source, target);
  const post = getPostByPermalink(target);
  const status = cfg.webmentions.moderation ? "pending" : "approved";

  getDb()
    .query(
      `INSERT INTO webmentions
        (source, target, post_slug, type, author_name, author_url, author_avatar, content, published, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(source, target) DO UPDATE SET
        type = excluded.type, author_name = excluded.author_name,
        author_url = excluded.author_url, author_avatar = excluded.author_avatar,
        content = excluded.content, published = excluded.published`,
    )
    .run(
      source,
      target,
      post?.slug ?? null,
      parsed.type,
      parsed.authorName,
      parsed.authorUrl,
      parsed.authorAvatar,
      parsed.content,
      parsed.published,
      status,
    );

  if (status === "approved") scheduleFullBuild(2000);
  return true;
}

interface ParsedMention {
  type: string;
  authorName: string | null;
  authorUrl: string | null;
  authorAvatar: string | null;
  content: string | null;
  published: string | null;
}

/** Extract h-entry data and the mention type from source HTML. */
export function parseSource(html: string, source: string, target: string): ParsedMention {
  const result: ParsedMention = {
    type: "mention",
    authorName: null,
    authorUrl: null,
    authorAvatar: null,
    content: null,
    published: null,
  };
  let data: any;
  try {
    data = mf2(html, { baseUrl: source });
  } catch {
    return result;
  }

  const entry = (data.items ?? []).find((i: any) => (i.type ?? []).includes("h-entry"));
  if (!entry) return result;
  const p = entry.properties ?? {};

  if (arrayHas(p["in-reply-to"], target)) result.type = "reply";
  else if (arrayHas(p["like-of"], target)) result.type = "like";
  else if (arrayHas(p["repost-of"], target)) result.type = "repost";
  else if (arrayHas(p["bookmark-of"], target)) result.type = "bookmark";

  const author = p.author?.[0];
  if (author && typeof author === "object" && author.properties) {
    result.authorName = author.properties.name?.[0] ?? null;
    result.authorUrl = author.properties.url?.[0] ?? null;
    result.authorAvatar = author.properties.photo?.[0]?.value ?? author.properties.photo?.[0] ?? null;
  } else if (typeof author === "string") {
    result.authorName = author;
  }

  const content = p.content?.[0];
  if (content) result.content = typeof content === "object" ? content.value : String(content);
  result.published = p.published?.[0] ?? null;
  return result;
}

function arrayHas(arr: any[] | undefined, value: string): boolean {
  if (!arr) return false;
  return arr.some((v) => {
    const s = typeof v === "object" ? v.value ?? v.url : v;
    return s === value;
  });
}
