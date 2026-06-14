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
import type { SyndicationRow, PostRow, SocialReplyRow } from "../db/schema.ts";

const REPLIES_DIR = join(HUGO_SITE, "data", "replies");

/** Upsert a social reply, returning true if it was newly inserted. */
function upsertReply(
  db: Database,
  row: Omit<SocialReplyRow, "id" | "replied" | "created_at">,
): void {
  db.query(
    `INSERT INTO social_replies
      (platform, post_slug, remote_id, remote_cid, root_id, root_cid, author, author_url, avatar, content, url, published)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(platform, remote_id) DO UPDATE SET content = excluded.content, avatar = excluded.avatar`,
  ).run(
    row.platform, row.post_slug, row.remote_id, row.remote_cid, row.root_id, row.root_cid,
    row.author, row.author_url, row.avatar, row.content, row.url, row.published,
  );
}

/**
 * Poll cross-posting platforms for replies to syndicated posts. Replies are
 * stored in the social_replies table (for the unified Mentions tab) and also
 * written to hugo-site/data/replies/<slug>.json for themes to render.
 */
export async function pollReplies(db: Database = getDb()): Promise<number> {
  const cfg = getConfig();
  const rows = db
    .query("SELECT * FROM syndications WHERE status = 'success' AND remote_id IS NOT NULL")
    .all() as SyndicationRow[];
  if (!rows.length) return 0;

  await mkdir(REPLIES_DIR, { recursive: true });
  let count = 0;

  for (const syn of rows) {
    const post = db.query("SELECT * FROM posts WHERE id = ?").get(syn.post_id) as PostRow | null;
    if (!post) continue;

    try {
      if (syn.platform === "mastodon" && cfg.crossposting.mastodon.enabled && isConnected("mastodon")) {
        for (const r of await fetchMastodonReplies(syn.remote_id!)) {
          upsertReply(db, {
            platform: "mastodon", post_slug: post.slug, remote_id: r.id, remote_cid: null,
            root_id: null, root_cid: null,
            author: r.account?.display_name || r.account?.username || "",
            author_url: r.account?.url ?? null, avatar: r.account?.avatar ?? null,
            content: stripHtml(r.content ?? ""), url: r.url ?? null, published: r.created_at ?? null,
          });
          count++;
        }
      }
      if (syn.platform === "bluesky" && cfg.crossposting.bluesky.enabled && isConnected("bluesky")) {
        const { root, replies } = await fetchBlueskyReplies(syn.remote_id!);
        for (const r of replies) {
          const p = r.post;
          if (!p) continue;
          const rkey = (p.uri as string).split("/").pop();
          upsertReply(db, {
            platform: "bluesky", post_slug: post.slug, remote_id: p.uri, remote_cid: p.cid,
            root_id: root?.uri ?? syn.remote_id!, root_cid: root?.cid ?? null,
            author: p.author?.displayName || p.author?.handle || "",
            author_url: p.author?.handle ? `https://bsky.app/profile/${p.author.handle}` : null,
            avatar: p.author?.avatar ?? null, content: p.record?.text ?? "",
            url: p.author?.handle ? `https://bsky.app/profile/${p.author.handle}/post/${rkey}` : null,
            published: p.record?.createdAt ?? null,
          });
          count++;
        }
      }
    } catch (err) {
      console.warn(`[reply-poll] ${syn.platform}`, (err as Error).message);
    }
  }

  // Write theme data grouped by slug.
  const all = db.query("SELECT * FROM social_replies ORDER BY created_at ASC").all() as SocialReplyRow[];
  const bySlug = new Map<string, any[]>();
  for (const r of all) {
    const slug = r.post_slug || "_site";
    if (!bySlug.has(slug)) bySlug.set(slug, []);
    bySlug.get(slug)!.push({
      platform: r.platform, author: r.author, author_url: r.author_url,
      avatar: r.avatar, content: r.content, url: r.url, published: r.published,
    });
  }
  for (const [slug, replies] of bySlug) {
    await Bun.write(join(REPLIES_DIR, `${slug}.json`), JSON.stringify(replies, null, 2));
  }
  if (count) scheduleFullBuild(2000);
  return count;
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, "").trim();
}
