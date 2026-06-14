import type { Database } from "bun:sqlite";
import { getDb } from "../db/index.ts";
import { getConfig } from "../lib/config.ts";
import type { PostRow, WebmentionQueueRow } from "../db/schema.ts";
import { readPostFile, parseFrontMatter, permalinkFor } from "./content.ts";

const LINK_RE = /\[[^\]]*\]\((https?:\/\/[^)\s]+)\)|<(https?:\/\/[^>\s]+)>|(?<![("<])(https?:\/\/[^\s)<]+)/g;

/** Extract outbound HTTP(S) links from Markdown/text body. */
export function extractLinks(body: string): string[] {
  const links = new Set<string>();
  let m: RegExpExecArray | null;
  LINK_RE.lastIndex = 0;
  while ((m = LINK_RE.exec(body)) !== null) {
    const url = m[1] || m[2] || m[3];
    if (url) links.add(url.replace(/[.,)]+$/, ""));
  }
  return [...links];
}

function isExternal(url: string): boolean {
  try {
    return new URL(url).hostname !== new URL(getConfig().site.url).hostname;
  } catch {
    return false;
  }
}

/** Queue outgoing webmentions for all external links in a post. */
export async function scanPost(post: PostRow, db: Database = getDb()): Promise<number> {
  const cfg = getConfig();
  if (!cfg.webmentions.send) return 0;
  const raw = await readPostFile(post);
  const { frontMatter, body } = parseFrontMatter(raw);
  const date = frontMatter.date ? new Date(frontMatter.date) : new Date(post.created_at);
  const source = permalinkFor(date, post.slug);

  const targets = new Set(extractLinks(body).filter(isExternal));
  if (frontMatter.reply_to_url) targets.add(frontMatter.reply_to_url);
  if (frontMatter.bookmark_url) targets.add(frontMatter.bookmark_url);

  let queued = 0;
  for (const target of targets) {
    const exists = db
      .query("SELECT 1 FROM webmention_queue WHERE source = ? AND target = ?")
      .get(source, target);
    if (exists) continue;
    db.query("INSERT INTO webmention_queue (source, target) VALUES (?, ?)").run(source, target);
    queued++;
  }
  return queued;
}

/** Discover a target's Webmention endpoint (Link header, then <link>/<a>). */
export async function discoverEndpoint(
  target: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  const res = await fetchImpl(target, { headers: { accept: "text/html" } });
  if (!res.ok) return null;

  const linkHeader = res.headers.get("link");
  if (linkHeader) {
    const fromHeader = parseLinkHeader(linkHeader, target);
    if (fromHeader) return fromHeader;
  }

  const html = await res.text();
  const fromHtml = parseHtmlEndpoint(html, target);
  return fromHtml;
}

function parseLinkHeader(header: string, base: string): string | null {
  // e.g. <https://example.com/wm>; rel="webmention"
  const parts = header.split(",");
  for (const part of parts) {
    const m = part.match(/<([^>]+)>\s*;\s*(.+)/);
    if (!m) continue;
    if (/rel\s*=\s*"?[^"]*\bwebmention\b/i.test(m[2])) {
      return new URL(m[1], base).toString();
    }
  }
  return null;
}

export function parseHtmlEndpoint(html: string, base: string): string | null {
  // <link rel="webmention" href="..."> or <a rel="webmention" href="...">
  const re = /<(?:link|a)[^>]+rel=["']?[^"'>]*webmention[^"'>]*["']?[^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const href = m[0].match(/href=["']([^"']+)["']/i);
    if (href) {
      try {
        return new URL(href[1], base).toString();
      } catch {
        /* ignore */
      }
    }
  }
  return null;
}

/** Send a single webmention. */
export async function sendOne(
  source: string,
  target: string,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  const endpoint = await discoverEndpoint(target, fetchImpl);
  if (!endpoint) return false;
  const res = await fetchImpl(endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ source, target }).toString(),
  });
  return res.ok || res.status === 202 || res.status === 201;
}

/** Work the outgoing queue (max 3 attempts, exponential backoff). */
export async function processQueue(
  db: Database = getDb(),
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const rows = db
    .query("SELECT * FROM webmention_queue WHERE status = 'pending' AND attempts < 3")
    .all() as WebmentionQueueRow[];

  for (const row of rows) {
    // Exponential backoff: skip until enough time has elapsed.
    if (row.last_attempt) {
      const wait = Math.pow(2, row.attempts) * 60_000; // 1m, 2m, 4m
      if (Date.now() - new Date(row.last_attempt).getTime() < wait) continue;
    }
    let ok = false;
    try {
      ok = await sendOne(row.source, row.target, fetchImpl);
    } catch {
      ok = false;
    }
    const attempts = row.attempts + 1;
    const status = ok ? "sent" : attempts >= 3 ? "failed" : "pending";
    db.query(
      "UPDATE webmention_queue SET status = ?, attempts = ?, last_attempt = CURRENT_TIMESTAMP WHERE id = ?",
    ).run(status, attempts, row.id);
  }
}
