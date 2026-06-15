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
  // Tests drive dispatch explicitly (and have no real tokens), so skip the
  // automatic microtask there to keep queued state observable and deterministic.
  if (process.env.MACROBLOG_NO_DISPATCH === "1") return;
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
  const categories = Array.isArray(frontMatter.categories)
    ? frontMatter.categories.map((c: any) => String(c)).filter(Boolean)
    : [];

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
    categories,
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

/**
 * Process all pending syndications for published posts.
 *
 * Rows are *claimed* atomically (pending → sending) before any network call, so
 * two concurrent callers — the post-publish `dispatchSoon()` and the 60s
 * scheduler tick — can never both grab the same row and cross-post it twice.
 * bun:sqlite runs synchronously, so the claiming UPDATE…RETURNING completes
 * before any `await` yields the event loop.
 */
export async function processPending(db: Database = getDb()): Promise<number> {
  const claimed = db
    .query(
      `UPDATE syndications SET status = 'sending'
       WHERE status = 'pending'
         AND post_id IN (SELECT id FROM posts WHERE status = 'published')
       RETURNING *`,
    )
    .all() as SyndicationRow[];
  for (const row of claimed) {
    await dispatchOne(row, db);
  }
  return claimed.length;
}

/**
 * Reset rows stuck in the transient 'sending' state back to 'pending' — used on
 * startup so a crash mid-dispatch doesn't strand a syndication forever.
 */
export function resetStuckSyndications(db: Database = getDb()): number {
  const res = db
    .query("UPDATE syndications SET status = 'pending' WHERE status = 'sending'")
    .run();
  return res.changes ?? 0;
}

export async function retrySyndication(id: number, db: Database = getDb()): Promise<boolean> {
  // Claim atomically so a concurrent scheduler tick can't also pick this up.
  const claimed = db
    .query("UPDATE syndications SET status = 'sending', error = NULL WHERE id = ? AND status != 'sending' RETURNING *")
    .all(id) as SyndicationRow[];
  if (!claimed.length) return false;
  await dispatchOne(claimed[0], db);
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
