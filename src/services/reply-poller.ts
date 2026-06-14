import type { Database } from "bun:sqlite";
import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import { getDb } from "../db/index.ts";
import { getConfig } from "../lib/config.ts";
import { isConnected } from "../lib/tokens.ts";
import { HUGO_SITE } from "./content.ts";
import { scheduleFullBuild } from "./hugo.ts";
import { fetchMastodonReplies } from "./crosspost/mastodon.ts";
import { fetchBlueskyReplies } from "./crosspost/bluesky.ts";
import type { SyndicationRow, PostRow } from "../db/schema.ts";

const REPLIES_DIR = join(HUGO_SITE, "data", "replies");

interface NormalizedReply {
  platform: string;
  author: string;
  author_url?: string;
  avatar?: string;
  content: string;
  url?: string;
  published?: string;
}

/**
 * Poll cross-posting platforms for replies to syndicated posts and write them
 * into hugo-site/data/replies/<slug>.json for themes to render.
 */
export async function pollReplies(db: Database = getDb()): Promise<number> {
  const cfg = getConfig();
  const rows = db
    .query("SELECT * FROM syndications WHERE status = 'success' AND remote_id IS NOT NULL")
    .all() as SyndicationRow[];
  if (!rows.length) return 0;

  await mkdir(REPLIES_DIR, { recursive: true });
  const bySlug = new Map<string, NormalizedReply[]>();
  let count = 0;

  for (const syn of rows) {
    const post = db.query("SELECT * FROM posts WHERE id = ?").get(syn.post_id) as PostRow | null;
    if (!post) continue;

    try {
      if (syn.platform === "mastodon" && cfg.crossposting.mastodon.enabled && isConnected("mastodon")) {
        const replies = await fetchMastodonReplies(syn.remote_id!);
        for (const r of replies) {
          addReply(bySlug, post.slug, {
            platform: "mastodon",
            author: r.account?.display_name || r.account?.username || "",
            author_url: r.account?.url,
            avatar: r.account?.avatar,
            content: stripHtml(r.content ?? ""),
            url: r.url,
            published: r.created_at,
          });
          count++;
        }
      }
      if (syn.platform === "bluesky" && cfg.crossposting.bluesky.enabled && isConnected("bluesky")) {
        const replies = await fetchBlueskyReplies(syn.remote_id!);
        for (const r of replies) {
          const p = r.post;
          if (!p) continue;
          addReply(bySlug, post.slug, {
            platform: "bluesky",
            author: p.author?.displayName || p.author?.handle || "",
            author_url: p.author?.handle ? `https://bsky.app/profile/${p.author.handle}` : undefined,
            avatar: p.author?.avatar,
            content: p.record?.text ?? "",
            published: p.record?.createdAt,
          });
          count++;
        }
      }
    } catch (err) {
      console.warn(`[reply-poll] ${syn.platform}`, (err as Error).message);
    }
  }

  for (const [slug, replies] of bySlug) {
    await Bun.write(join(REPLIES_DIR, `${slug}.json`), JSON.stringify(replies, null, 2));
  }
  if (bySlug.size) scheduleFullBuild(2000);
  return count;
}

function addReply(map: Map<string, NormalizedReply[]>, slug: string, reply: NormalizedReply): void {
  if (!map.has(slug)) map.set(slug, []);
  map.get(slug)!.push(reply);
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, "").trim();
}
