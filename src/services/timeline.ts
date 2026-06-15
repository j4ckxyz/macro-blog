import type { Database } from "bun:sqlite";
import { getDb } from "../db/index.ts";
import { getConfig } from "../lib/config.ts";
import { isConnected, getTokenExtra } from "../lib/tokens.ts";
import { fetchBlueskyTimeline } from "./crosspost/bluesky.ts";
import { fetchMastodonHomeTimeline } from "./crosspost/mastodon.ts";
import type { TimelineRow } from "../db/schema.ts";

export interface TimelineMedia {
  url: string;
  alt?: string;
}

export interface NormalizedTimelineItem {
  platform: "bluesky" | "mastodon";
  remoteId: string;
  remoteCid?: string | null;
  rootUri?: string | null;
  rootCid?: string | null;
  author: string;
  authorHandle: string;
  avatar: string;
  content: string;
  url: string;
  media: TimelineMedia[];
  repostedBy?: string | null;
  createdAt: string; // ISO
  isReply?: boolean;
}

const MAX_ITEMS = 2000;

function upsert(db: Database, item: NormalizedTimelineItem): void {
  db.query(
    `INSERT INTO timeline
      (platform, remote_id, remote_cid, root_uri, root_cid, author_name, author_handle, author_avatar, author_url, content, url, media_json, reposted_by, created_at, is_reply, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(platform, remote_id) DO UPDATE SET
       content = excluded.content, author_avatar = excluded.author_avatar,
       reposted_by = excluded.reposted_by, is_reply = excluded.is_reply, 
       remote_cid = excluded.remote_cid, root_uri = excluded.root_uri, 
       root_cid = excluded.root_cid, fetched_at = CURRENT_TIMESTAMP`,
  ).run(
    item.platform, item.remoteId, item.remoteCid ?? null, item.rootUri ?? null, item.rootCid ?? null,
    item.author, item.authorHandle, item.avatar,
    item.url, item.content, item.url, JSON.stringify(item.media || []),
    item.repostedBy ?? null, item.createdAt, item.isReply ? 1 : 0,
  );
}

export interface RefreshResult {
  bluesky: number;
  mastodon: number;
  errors: string[];
}

/** Pull both following feeds and cache them server-side. */
export async function refreshTimeline(db: Database = getDb()): Promise<RefreshResult> {
  const cfg = getConfig();
  const result: RefreshResult = { bluesky: 0, mastodon: 0, errors: [] };

  if (cfg.crossposting.bluesky.enabled && isConnected("bluesky")) {
    const handle = getTokenExtra("bluesky").handle || "?";
    try {
      console.log(`[timeline] bluesky: fetching following feed as @${handle}…`);
      const items = await fetchBlueskyTimeline(50);
      for (const it of items) upsert(db, it);
      result.bluesky = items.length;
      console.log(`[timeline] bluesky: fetched ${items.length} posts`);
    } catch (err) {
      const msg = (err as Error).message;
      result.errors.push("bluesky: " + msg);
      console.error(`[timeline] bluesky FAILED: ${msg}`);
    }
  } else if (cfg.crossposting.bluesky.enabled) {
    console.warn("[timeline] bluesky enabled but not connected — connect it in Settings");
  }
  if (cfg.crossposting.mastodon.enabled && isConnected("mastodon")) {
    const inst = cfg.crossposting.mastodon.instance_url || "?";
    try {
      console.log(`[timeline] mastodon: fetching home timeline from ${inst}…`);
      const items = await fetchMastodonHomeTimeline(40);
      for (const it of items) upsert(db, it);
      result.mastodon = items.length;
      console.log(`[timeline] mastodon: fetched ${items.length} posts`);
    } catch (err) {
      const msg = (err as Error).message;
      result.errors.push("mastodon: " + msg);
      console.error(`[timeline] mastodon FAILED: ${msg}`);
    }
  } else if (cfg.crossposting.mastodon.enabled) {
    console.warn("[timeline] mastodon enabled but not connected — connect it in Settings");
  }

  // Prune to the newest MAX_ITEMS.
  db.query(
    `DELETE FROM timeline WHERE id NOT IN (
       SELECT id FROM timeline ORDER BY created_at DESC LIMIT ?
     )`,
  ).run(MAX_ITEMS);

  return result;
}

export interface TimelineItem extends Omit<NormalizedTimelineItem, "media"> {
  media: TimelineMedia[];
}

/** Read the cached timeline (instant — no network), optionally filtered by a search query. */
export function getTimeline(limit = 100, q?: string, db: Database = getDb()): TimelineItem[] {
  let rows: TimelineRow[];
  if (q) {
    rows = db
      .query(`SELECT * FROM timeline 
              WHERE content LIKE ? OR author_name LIKE ? OR author_handle LIKE ? 
              ORDER BY created_at DESC LIMIT ?`)
      .all(`%${q}%`, `%${q}%`, `%${q}%`, limit) as TimelineRow[];
  } else {
    rows = db
      .query("SELECT * FROM timeline ORDER BY created_at DESC LIMIT ?")
      .all(limit) as TimelineRow[];
  }
  return rows.map((r) => ({
    platform: r.platform as "bluesky" | "mastodon",
    remoteId: r.remote_id,
    remoteCid: r.remote_cid,
    rootUri: r.root_uri,
    rootCid: r.root_cid,
    author: r.author_name || "",
    authorHandle: r.author_handle || "",
    avatar: r.author_avatar || "",
    content: r.content || "",
    url: r.url || "",
    media: r.media_json ? JSON.parse(r.media_json) : [],
    repostedBy: r.reposted_by,
    createdAt: r.created_at || "",
    isReply: !!r.is_reply,
  }));
}
