import type { Database } from "bun:sqlite";
import { getDb } from "../db/index.ts";
import { getConfig } from "../lib/config.ts";
import type { PostRow, SyndicationRow } from "../db/schema.ts";
import { readPostFile, parseFrontMatter, addSyndicationUrl, permalinkFor } from "./content.ts";
import { crosspostMastodon } from "./crosspost/mastodon.ts";
import { crosspostBluesky } from "./crosspost/bluesky.ts";
import type { CrosspostPayload, CrosspostResult } from "./crosspost/types.ts";
import type { PostType } from "../lib/micropub-parser.ts";

export const PLATFORMS = ["bluesky", "mastodon"] as const;
export type Platform = (typeof PLATFORMS)[number];

const DISPATCHERS: Record<Platform, (p: CrosspostPayload) => Promise<CrosspostResult>> = {
  bluesky: crosspostBluesky,
  mastodon: crosspostMastodon,
};

/** Queue syndication intents for a post (idempotent per platform). */
export function queueSyndication(
  postId: number,
  platforms: string[],
  db: Database = getDb(),
): void {
  for (const platform of platforms) {
    if (!PLATFORMS.includes(platform as Platform)) continue;
    const exists = db
      .query("SELECT 1 FROM syndications WHERE post_id = ? AND platform = ?")
      .get(postId, platform);
    if (exists) continue;
    db.query("INSERT INTO syndications (post_id, platform, status) VALUES (?, ?, 'pending')").run(
      postId,
      platform,
    );
    console.log(`[syndication] queued post ${postId} → ${platform}`);
  }
}

/**
 * Dispatch any pending syndications right away (called after publishing so
 * cross-posts go out immediately instead of waiting for the 60s scheduler).
 */
export function dispatchSoon(): void {
  queueMicrotask(() => {
    processPending().catch((e) => console.error("[syndication] dispatch error:", (e as Error).message));
  });
}

/** Strip Markdown to a plain-text representation for cross-posting. */
export function markdownToText(md: string): string {
  return md
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "") // images
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 $2") // links -> text + url
    .replace(/^#{1,6}\s+/gm, "") // headings
    .replace(/(\*\*|__)(.*?)\1/g, "$2") // bold
    .replace(/(\*|_)(.*?)\1/g, "$2") // italic
    .replace(/`([^`]+)`/g, "$1") // inline code
    .replace(/^>\s?/gm, "") // blockquotes
    .replace(/\r/g, "")
    .trim();
}

function absolutize(url: string): string {
  if (/^https?:\/\//.test(url)) return url;
  return getConfig().site.url.replace(/\/+$/, "") + (url.startsWith("/") ? url : "/" + url);
}

/** Build a cross-post payload from a stored post. */
export async function buildPayload(post: PostRow): Promise<CrosspostPayload> {
  const raw = await readPostFile(post);
  const { frontMatter, body } = parseFrontMatter(raw);
  const date = frontMatter.date ? new Date(frontMatter.date) : new Date(post.created_at);
  const permalink = permalinkFor(date, post.slug);

  const photos = Array.isArray(frontMatter.photos)
    ? frontMatter.photos.map((p: any) => ({
        url: absolutize(p.url),
        alt: p.alt,
        width: p.width ? Number(p.width) : undefined,
        height: p.height ? Number(p.height) : undefined,
      }))
    : [];

  const linkBack = frontMatter.link_back !== false;

  return {
    text: markdownToText(body),
    markdown: body,
    url: permalink,
    title: frontMatter.title || undefined,
    type: post.post_type as PostType,
    photos,
    inReplyTo: frontMatter.reply_to_url || undefined,
    linkBack,
    lang: frontMatter.lang || undefined,
  };
}

/** Dispatch a single syndication record. */
export async function dispatchOne(syn: SyndicationRow, db: Database = getDb()): Promise<void> {
  const post = db.query("SELECT * FROM posts WHERE id = ?").get(syn.post_id) as PostRow | null;
  if (!post) {
    db.query("UPDATE syndications SET status = 'failed', error = 'post not found' WHERE id = ?").run(syn.id);
    return;
  }
  try {
    console.log(`[syndication] dispatching post "${post.slug}" → ${syn.platform}…`);
    const payload = await buildPayload(post);
    const result = await DISPATCHERS[syn.platform as Platform](payload);
    db.query(
      "UPDATE syndications SET status = 'success', remote_id = ?, remote_url = ?, error = NULL WHERE id = ?",
    ).run(result.remoteId, result.remoteUrl, syn.id);
    await addSyndicationUrl(post, result.remoteUrl);
    console.log(`[syndication] ✓ ${syn.platform}: ${result.remoteUrl}`);
  } catch (err) {
    const msg = (err as Error).message;
    db.query("UPDATE syndications SET status = 'failed', error = ? WHERE id = ?").run(msg, syn.id);
    console.error(`[syndication] ✗ ${syn.platform} failed for "${post.slug}": ${msg}`);
  }
}

/** Process all pending syndications for published posts. */
export async function processPending(db: Database = getDb()): Promise<number> {
  const rows = db
    .query(
      `SELECT s.* FROM syndications s
       JOIN posts p ON p.id = s.post_id
       WHERE s.status = 'pending' AND p.status = 'published'`,
    )
    .all() as SyndicationRow[];
  for (const row of rows) {
    await dispatchOne(row, db);
  }
  return rows.length;
}

export async function retrySyndication(id: number, db: Database = getDb()): Promise<boolean> {
  const row = db.query("SELECT * FROM syndications WHERE id = ?").get(id) as SyndicationRow | null;
  if (!row) return false;
  db.query("UPDATE syndications SET status = 'pending', error = NULL WHERE id = ?").run(id);
  await dispatchOne({ ...row, status: "pending" }, db);
  return true;
}

export function listSyndicateTargets() {
  const cfg = getConfig();
  const targets: { uid: string; name: string }[] = [];
  if (cfg.crossposting.bluesky.enabled) targets.push({ uid: "bluesky", name: "Bluesky" });
  if (cfg.crossposting.mastodon.enabled) {
    const host = cfg.crossposting.mastodon.instance_url.replace(/^https?:\/\//, "").replace(/\/+$/, "");
    targets.push({ uid: "mastodon", name: host ? `Mastodon (${host})` : "Mastodon" });
  }
  return targets;
}
