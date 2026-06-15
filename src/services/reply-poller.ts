import type { Database } from "bun:sqlite";
import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import { getDb } from "../db/index.ts";
import { getConfig } from "../lib/config.ts";
import { isConnected } from "../lib/tokens.ts";
import { HUGO_SITE } from "./content.ts";
import { scheduleFullBuild } from "./hugo.ts";
import { fetchMastodonReplies, fetchMastodonMentions } from "./crosspost/mastodon.ts";
import { fetchBlueskyReplies, fetchBlueskyMentions } from "./crosspost/bluesky.ts";
import { isConnected as platformConnected } from "../lib/tokens.ts";
import type { NormalizedMention } from "./crosspost/types.ts";
import type { SyndicationRow, PostRow, SocialReplyRow } from "../db/schema.ts";

const REPLIES_DIR = join(HUGO_SITE, "data", "replies");

/** Upsert a social reply/mention, preserving any richer fields on conflict. */
function upsertReply(
  db: Database,
  row: Omit<SocialReplyRow, "id" | "replied" | "created_at">,
): void {
  db.query(
    `INSERT INTO social_replies
      (platform, post_slug, remote_id, remote_cid, root_id, root_cid, author, author_handle,
       author_url, avatar, content, url, published, reason, media_json, embed_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(platform, remote_id) DO UPDATE SET
       content = excluded.content, avatar = excluded.avatar,
       media_json = excluded.media_json, embed_json = excluded.embed_json,
       reason = COALESCE(excluded.reason, social_replies.reason)`,
  ).run(
    row.platform, row.post_slug, row.remote_id, row.remote_cid, row.root_id, row.root_cid,
    row.author, row.author_handle ?? null, row.author_url, row.avatar, row.content, row.url,
    row.published, row.reason ?? null, row.media_json ?? null, row.embed_json ?? null,
  );
}

/** Pull @-mentions / replies / quotes from Bluesky + Mastodon into the inbox. */
export async function pollMentions(db: Database = getDb()): Promise<number> {
  const cfg = getConfig();
  let count = 0;
  const store = (m: NormalizedMention) => {
    upsertReply(db, {
      platform: m.platform, post_slug: null, remote_id: m.remoteId, remote_cid: m.remoteCid ?? null,
      root_id: m.rootId ?? null, root_cid: m.rootCid ?? null, author: m.author,
      author_handle: m.authorHandle ?? null, author_url: m.authorUrl ?? null, avatar: m.avatar ?? null,
      content: m.content, url: m.url ?? null, published: m.published ?? null, reason: m.reason,
      media_json: m.media?.length ? JSON.stringify(m.media) : null,
      embed_json: m.embed ? JSON.stringify(m.embed) : null,
    });
    count++;
  };
  if (cfg.crossposting.bluesky.enabled && platformConnected("bluesky")) {
    try {
      for (const m of await fetchBlueskyMentions(40)) store(m);
    } catch (err) {
      console.warn("[mentions] bluesky", (err as Error).message);
    }
  }
  if (cfg.crossposting.mastodon.enabled && platformConnected("mastodon")) {
    try {
      for (const m of await fetchMastodonMentions(40)) store(m);
    } catch (err) {
      console.warn("[mentions] mastodon", (err as Error).message);
    }
  }
  return count;
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
            author_handle: r.account?.acct ? "@" + r.account.acct : null,
            author_url: r.account?.url ?? null, avatar: r.account?.avatar ?? null,
            content: stripHtml(r.content ?? ""), url: r.url ?? null, published: r.created_at ?? null,
            reason: "reply",
            media_json: Array.isArray(r.media_attachments) && r.media_attachments.length
              ? JSON.stringify(r.media_attachments.map((m: any) => ({ url: m.url, alt: m.description || "", type: m.type || "image" })))
              : null,
            embed_json: null,
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
            author_handle: p.author?.handle ? "@" + p.author.handle : null,
            author_url: p.author?.handle ? `https://bsky.app/profile/${p.author.handle}` : null,
            avatar: p.author?.avatar ?? null, content: p.record?.text ?? "",
            url: p.author?.handle ? `https://bsky.app/profile/${p.author.handle}/post/${rkey}` : null,
            published: p.record?.createdAt ?? null,
            reason: "reply", media_json: null, embed_json: null,
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
