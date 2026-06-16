/**
 * Import parsers for migrating content into Macroblog from common exports.
 *
 * Each parser returns a normalised `ImportRecord[]`. The cardinal rule is
 * **date backfilling**: every record carries the ORIGINAL publication date
 * parsed from the source (never "now"), so an import preserves your archive's
 * real timeline. The API layer turns these records into posts.
 */

import yaml from "js-yaml";
import type { PostType } from "../lib/micropub-parser.ts";
import type { ZipEntry } from "./zip.ts";

export type ImportSource = "microblog" | "twitter" | "rss" | "wordpress" | "instagram";

export interface ImportRecord {
  type: PostType;
  title?: string;
  content: string; // markdown
  date: string; // ISO 8601 — the original publication time
  categories: string[];
  photos: { url: string; alt?: string }[];
  sourceUrl?: string; // original permalink, if known (used for reference/dedupe)
}

/* ------------------------------------------------------------------ */
/* shared helpers                                                      */
/* ------------------------------------------------------------------ */

/** Convert a loose HTML fragment to Markdown (best-effort, dependency-free). */
export function htmlToMarkdown(html: string): string {
  if (!html) return "";
  let md = html;
  md = md.replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, "$1\n\n");
  md = md.replace(/<br\s*\/?>/gi, "\n");
  md = md.replace(/<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, "[$2]($1)");
  md = md.replace(/<img[^>]+src="([^"]+)"[^>]*alt="([^"]*)"[^>]*>/gi, "![$2]($1)");
  md = md.replace(/<img[^>]+alt="([^"]*)"[^>]+src="([^"]+)"[^>]*>/gi, "![$1]($2)");
  md = md.replace(/<img[^>]+src="([^"]+)"[^>]*>/gi, "![]($1)");
  md = md.replace(/<(strong|b)>([\s\S]*?)<\/\1>/gi, "**$2**");
  md = md.replace(/<(em|i)>([\s\S]*?)<\/\1>/gi, "_$2_");
  md = md.replace(/<code>([\s\S]*?)<\/code>/gi, "`$1`");
  md = md.replace(/<[^>]+>/g, "");
  md = decodeEntities(md);
  return md.replace(/\n{3,}/g, "\n\n").trim();
}

export function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));
}

function stripCdata(s: string): string {
  return s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
}

/** All inner contents of `<tag …>…</tag>` (tag name may contain a namespace). */
function innerTags(xml: string, tag: string): string[] {
  const t = tag.replace(/[:]/g, "\\:");
  const re = new RegExp(`<${t}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${t}>`, "gi");
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) out.push(m[1]);
  return out;
}

/** First inner content of `<tag>`, CDATA-stripped and trimmed. */
function firstTag(xml: string, tag: string): string {
  const all = innerTags(xml, tag);
  return all.length ? stripCdata(all[0]).trim() : "";
}

/** Normalise any parseable date to ISO; returns null if unparseable. */
export function toIso(value: string | number | undefined | null): string | null {
  if (value === undefined || value === null || value === "") return null;
  // Unix seconds or ms.
  if (typeof value === "number" || /^\d+$/.test(String(value))) {
    let n = Number(value);
    if (n < 1e12) n *= 1000; // seconds → ms
    const d = new Date(n);
    return isNaN(d.getTime()) ? null : d.toISOString();
  }
  let s = String(value).trim();
  // "2020-01-02 15:04:05" (WordPress GMT, no timezone) → treat as UTC.
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s)) s = s.replace(" ", "T") + "Z";
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

/** Drop sub-second precision so dates compare/dedupe cleanly. */
export function isoSeconds(iso: string): string {
  return iso.replace(/\.\d{3}Z$/, "Z");
}

/* ------------------------------------------------------------------ */
/* micro.blog / JSON Feed                                              */
/* ------------------------------------------------------------------ */

export function parseMicroblog(input: string | any): ImportRecord[] {
  const feed = typeof input === "string" ? JSON.parse(input) : input;
  const items = feed?.items || [];
  const records: ImportRecord[] = [];
  for (const item of items) {
    const iso = toIso(item.date_published) || toIso(item.date_modified);
    const title = item.title ? String(item.title).trim() : undefined;
    const content = htmlToMarkdown(item.content_html || "") || (item.content_text || "").trim();
    const photos: { url: string; alt?: string }[] = [];
    for (const att of item.attachments || []) {
      if (att?.url && (!att.mime_type || att.mime_type.startsWith("image/"))) {
        photos.push({ url: att.url, alt: att.title || "" });
      }
    }
    records.push({
      type: title ? "article" : photos.length ? "photo" : "post",
      title,
      content,
      date: iso || new Date().toISOString(),
      categories: Array.isArray(item.tags) ? item.tags.map(String) : [],
      photos,
      sourceUrl: item.url || item.id || undefined,
    });
  }
  return records;
}

/* ------------------------------------------------------------------ */
/* Micro.blog "Blog Archive Format" (Hugo Markdown export .zip)        */
/* ------------------------------------------------------------------ */

/** Map an upload reference to a local /uploads/ path. */
function rewriteUpload(url: string): string {
  if (!url) return url;
  // Absolute micro.blog upload URL → local path.
  const abs = url.match(/^https?:\/\/[^/]+\/(uploads\/.+)$/i);
  if (abs) return "/" + abs[1];
  if (/^uploads\//i.test(url)) return "/" + url;
  return url;
}

/** Rewrite absolute/relative upload URLs inside Markdown body text. */
function rewriteUploadsInText(text: string): string {
  return text
    .replace(/(https?:\/\/[^/\s)"']+)\/uploads\//gi, "/uploads/")
    .replace(/\]\(uploads\//gi, "](/uploads/");
}

/** Split YAML/TOML front matter from a Markdown file. */
function splitFrontMatter(text: string): { fm: Record<string, any>; body: string } {
  const y = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (y) {
    try {
      const fm = (yaml.load(y[1]) as Record<string, any>) || {};
      return { fm, body: y[2] ?? "" };
    } catch {
      return { fm: {}, body: y[2] ?? "" };
    }
  }
  const t = text.match(/^\+\+\+\r?\n([\s\S]*?)\r?\n\+\+\+\r?\n?([\s\S]*)$/);
  if (t) {
    const fm: Record<string, any> = {};
    for (const line of t[1].split(/\r?\n/)) {
      const kv = line.match(/^([a-zA-Z0-9_]+)\s*=\s*(.+)$/);
      if (kv) fm[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, "");
    }
    return { fm, body: t[2] ?? "" };
  }
  return { fm: {}, body: text };
}

/** Turn one exported Markdown file into an ImportRecord (or null to skip). */
function markdownFileToRecord(text: string): ImportRecord | null {
  const { fm, body } = splitFrontMatter(text);
  if (fm.draft === true || fm.published === false) return null;

  const title = fm.title && String(fm.title).trim() ? String(fm.title).trim() : undefined;
  const photos: { url: string; alt?: string }[] = [];
  const imgs = fm.images ?? fm.photos ?? (fm.image ? [fm.image] : []);
  if (Array.isArray(imgs)) {
    for (const im of imgs) {
      if (typeof im === "string") photos.push({ url: rewriteUpload(im) });
      else if (im && im.url) photos.push({ url: rewriteUpload(im.url), alt: im.alt || "" });
    }
  }

  const content = rewriteUploadsInText(String(body || "")).trim();
  if (!content && !photos.length && !title) return null; // blank

  const catsRaw = Array.isArray(fm.categories) ? fm.categories : Array.isArray(fm.tags) ? fm.tags : [];
  const categories = catsRaw.map((c: any) => String(c)).filter(Boolean);

  return {
    type: title ? "article" : photos.length ? "photo" : "post",
    title,
    content,
    date: toIso(fm.date ?? fm.published ?? fm.lastmod ?? fm.pubDate) || new Date().toISOString(),
    categories,
    photos,
    sourceUrl: fm.url ? String(fm.url) : undefined,
  };
}

export interface ArchiveImport {
  records: ImportRecord[];
  /** Media to write under the uploads dir, keyed by path relative to uploads/. */
  uploads: { path: string; data: Uint8Array }[];
}

/**
 * Parse a Micro.blog Blog Archive (Hugo Markdown export). Markdown files become
 * posts (microposts have no title); anything under uploads/ is collected so the
 * caller can write it into the media library, keeping image references valid.
 */
export function parseMicroblogArchive(entries: ZipEntry[]): ArchiveImport {
  const records: ImportRecord[] = [];
  const uploads: { path: string; data: Uint8Array }[] = [];
  const dec = new TextDecoder();

  for (const e of entries) {
    const path = e.path.replace(/^\/+/, "");
    const lower = path.toLowerCase();
    const isMd = lower.endsWith(".md") || lower.endsWith(".markdown");

    // Uploaded media (images/audio/video) → keep for the media library.
    const up = lower.match(/(?:^|\/)uploads\/(.+)$/);
    if (up && !isMd) {
      uploads.push({ path: up[1], data: e.data });
      continue;
    }
    if (!isMd) continue;

    const base = path.split("/").pop() || "";
    if (base === "_index.md" || base === "index.md") continue; // section/page indexes
    if (/(^|\/)(pages|_pages)\//.test(lower)) continue; // standalone pages

    const rec = markdownFileToRecord(dec.decode(e.data));
    if (rec) records.push(rec);
  }
  return { records, uploads };
}

/* ------------------------------------------------------------------ */
/* Twitter / X archive (tweets.js / tweet.js)                          */
/* ------------------------------------------------------------------ */

export function parseTwitter(input: string): ImportRecord[] {
  // The archive file is JS: `window.YTD.tweets.part0 = [ … ]`. Strip the
  // assignment prefix to get the JSON array. Accept raw JSON too.
  let json = input.trim();
  const eq = json.indexOf("=");
  if (!json.startsWith("[") && eq !== -1) json = json.slice(eq + 1).trim();
  let arr: any[];
  try {
    arr = JSON.parse(json);
  } catch {
    return [];
  }
  const records: ImportRecord[] = [];
  for (const entry of arr) {
    const t = entry.tweet || entry;
    if (!t) continue;
    // Skip pure retweets — they aren't your authored content.
    let text: string = t.full_text ?? t.text ?? "";
    if (/^RT @/.test(text)) continue;
    // Skip replies — keep only your original tweets. The archive marks replies
    // with in_reply_to_* fields (a leading "@" also denotes a reply).
    if (t.in_reply_to_status_id_str || t.in_reply_to_user_id_str || /^@\w/.test(text.trim())) continue;

    // Expand t.co links to their real URLs.
    for (const u of t.entities?.urls || []) {
      if (u.url && u.expanded_url) text = text.split(u.url).join(u.expanded_url);
    }
    // Collect media and strip their t.co links from the text.
    const photos: { url: string; alt?: string }[] = [];
    const mediaList = t.extended_entities?.media || t.entities?.media || [];
    for (const m of mediaList) {
      if (m.url) text = text.split(m.url).join("");
      const url = m.media_url_https || m.media_url;
      if (url && (m.type === "photo" || !m.type)) {
        photos.push({ url, alt: m.ext_alt_text || "" });
      }
    }
    text = decodeEntities(text).replace(/[ \t]+\n/g, "\n").trim();
    // Skip blank tweets — nothing to publish (no text and no media).
    if (!text && !photos.length) continue;
    const iso = toIso(t.created_at);
    records.push({
      type: photos.length ? "photo" : "post",
      content: text,
      date: iso || new Date().toISOString(),
      categories: [],
      photos,
      sourceUrl: t.id_str ? `https://twitter.com/i/web/status/${t.id_str}` : undefined,
    });
  }
  return records;
}

/* ------------------------------------------------------------------ */
/* RSS 2.0 + Atom                                                      */
/* ------------------------------------------------------------------ */

export function parseRss(xml: string): ImportRecord[] {
  const records: ImportRecord[] = [];

  // RSS 2.0 <item>
  for (const item of innerTags(xml, "item")) {
    const title = firstTag(item, "title");
    const encoded = firstTag(item, "content:encoded");
    const desc = firstTag(item, "description");
    const html = encoded || desc;
    const dateRaw = firstTag(item, "pubDate") || firstTag(item, "dc:date");
    const categories = innerTags(item, "category").map((c) => stripCdata(c).trim()).filter(Boolean);
    records.push({
      type: title ? "article" : "post",
      title: title || undefined,
      content: htmlToMarkdown(html),
      date: toIso(dateRaw) || new Date().toISOString(),
      categories,
      photos: [],
      sourceUrl: firstTag(item, "link") || firstTag(item, "guid") || undefined,
    });
  }

  // Atom <entry>
  for (const entry of innerTags(xml, "entry")) {
    const title = firstTag(entry, "title");
    const content = firstTag(entry, "content") || firstTag(entry, "summary");
    const dateRaw = firstTag(entry, "published") || firstTag(entry, "updated");
    let link = "";
    const linkMatch = entry.match(/<link[^>]+href="([^"]+)"[^>]*\/?>/i);
    if (linkMatch) link = linkMatch[1];
    records.push({
      type: title ? "article" : "post",
      title: title || undefined,
      content: htmlToMarkdown(content),
      date: toIso(dateRaw) || new Date().toISOString(),
      categories: innerTags(entry, "category")
        .map((c) => {
          const term = c.match(/term="([^"]+)"/i);
          return term ? term[1] : stripCdata(c).trim();
        })
        .filter(Boolean),
      photos: [],
      sourceUrl: link || undefined,
    });
  }

  return records;
}

/* ------------------------------------------------------------------ */
/* WordPress WXR export                                                */
/* ------------------------------------------------------------------ */

export function parseWordpress(xml: string): ImportRecord[] {
  const records: ImportRecord[] = [];
  for (const item of innerTags(xml, "item")) {
    const status = firstTag(item, "wp:status");
    const postType = firstTag(item, "wp:post_type");
    // Only published posts/articles — skip drafts, attachments, nav menu items…
    if (postType && postType !== "post") continue;
    if (status && status !== "publish") continue;

    const title = firstTag(item, "title");
    const html = firstTag(item, "content:encoded");
    const dateRaw =
      firstTag(item, "wp:post_date_gmt") ||
      firstTag(item, "pubDate") ||
      firstTag(item, "wp:post_date");
    const categories = innerTags(item, "category").map((c) => stripCdata(c).trim()).filter(Boolean);
    records.push({
      type: title ? "article" : "post",
      title: title || undefined,
      content: htmlToMarkdown(html),
      date: toIso(dateRaw) || new Date().toISOString(),
      categories: [...new Set(categories)],
      photos: [],
      sourceUrl: firstTag(item, "link") || undefined,
    });
  }
  return records;
}

/* ------------------------------------------------------------------ */
/* Instagram archive (posts_1.json / your_instagram_activity)          */
/* ------------------------------------------------------------------ */

export function parseInstagram(input: string | any): ImportRecord[] {
  const data = typeof input === "string" ? JSON.parse(input) : input;
  // Exports vary: a bare array, or { media: [...] }, or { posts: [...] }.
  const list: any[] = Array.isArray(data) ? data : data?.media || data?.posts || [];
  const records: ImportRecord[] = [];
  for (const post of list) {
    const mediaArr: any[] = Array.isArray(post.media) ? post.media : [post];
    const photos: { url: string; alt?: string }[] = [];
    let ts: number | undefined = post.creation_timestamp;
    let caption = post.title || "";
    for (const m of mediaArr) {
      if (m.uri) photos.push({ url: m.uri, alt: m.title || "" });
      if (ts === undefined && m.creation_timestamp !== undefined) ts = m.creation_timestamp;
      if (!caption && m.title) caption = m.title;
    }
    if (!photos.length && !caption) continue;
    records.push({
      type: photos.length ? "photo" : "post",
      content: decodeEntities(String(caption || "")).trim(),
      date: toIso(ts) || new Date().toISOString(),
      categories: [],
      photos,
      sourceUrl: undefined,
    });
  }
  return records;
}

/* ------------------------------------------------------------------ */
/* dispatcher                                                          */
/* ------------------------------------------------------------------ */

export function parseImport(source: ImportSource, raw: string | any): ImportRecord[] {
  switch (source) {
    case "microblog":
      return parseMicroblog(raw);
    case "twitter":
      return parseTwitter(typeof raw === "string" ? raw : JSON.stringify(raw));
    case "rss":
      return parseRss(String(raw));
    case "wordpress":
      return parseWordpress(String(raw));
    case "instagram":
      return parseInstagram(raw);
    default:
      throw new Error(`unknown import source: ${source}`);
  }
}
