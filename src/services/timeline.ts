import type { Database } from "bun:sqlite";
import { getDb } from "../db/index.ts";
import { getConfig } from "../lib/config.ts";
import { isConnected } from "../lib/tokens.ts";
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
  author: string;
  authorHandle: string;
  avatar: string;
  content: string;
  url: string;
  media: TimelineMedia[];
  repostedBy?: string | null;
  createdAt: string; // ISO
}

const MAX_ITEMS = 200;

function upsert(db: Database, item: NormalizedTimelineItem): void {
  db.query(
    `INSERT INTO timeline
      (platform, remote_id, author_name, author_handle, author_avatar, author_url, content, url, media_json, reposted_by, created_at, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(platform, remote_id) DO UPDATE SET
       content = excluded.content, author_avatar = excluded.author_avatar,
       reposted_by = excluded.reposted_by, fetched_at = CURRENT_TIMESTAMP`,
  ).run(
    item.platform, item.remoteId, item.author, item.authorHandle, item.avatar,
    item.url, item.content, item.url, JSON.stringify(item.media || []),
    item.repostedBy ?? null, item.createdAt,
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
    try {
      const items = await fetchBlueskyTimeline(50);
      for (const it of items) upsert(db, it);
      result.bluesky = items.length;
    } catch (err) {
      result.errors.push("bluesky: " + (err as Error).message);
    }
  }
  if (cfg.crossposting.mastodon.enabled && isConnected("mastodon")) {
    try {
      const items = await fetchMastodonHomeTimeline(40);
      for (const it of items) upsert(db, it);
      result.mastodon = items.length;
    } catch (err) {
      result.errors.push("mastodon: " + (err as Error).message);
    }
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

/** Read the cached timeline (instant — no network). */
export function getTimeline(limit = 100, db: Database = getDb()): TimelineItem[] {
  const rows = db
    .query("SELECT * FROM timeline ORDER BY created_at DESC LIMIT ?")
    .all(limit) as TimelineRow[];
  return rows.map((r) => ({
    platform: r.platform as "bluesky" | "mastodon",
    remoteId: r.remote_id,
    author: r.author_name || "",
    authorHandle: r.author_handle || "",
    avatar: r.author_avatar || "",
    content: r.content || "",
    url: r.url || "",
    media: r.media_json ? JSON.parse(r.media_json) : [],
    repostedBy: r.reposted_by,
    createdAt: r.created_at || "",
  }));
}
