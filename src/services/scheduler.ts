import type { Database } from "bun:sqlite";
import { getDb } from "../db/index.ts";
import type { PostRow } from "../db/schema.ts";
import { join } from "node:path";
import {
  readPostFile,
  parseFrontMatter,
  serializeFrontMatter,
  CONTENT_DIR,
} from "./content.ts";
import { processPending, resetStuckSyndications } from "./syndication.ts";
import { processQueue } from "./webmention-send.ts";
import { scheduleFullBuild } from "./hugo.ts";
import { pollReplies, pollMentions } from "./reply-poller.ts";
import { refreshTimeline } from "./timeline.ts";

let timer: ReturnType<typeof setInterval> | null = null;
let replyTimer: ReturnType<typeof setInterval> | null = null;
let timelineTimer: ReturnType<typeof setInterval> | null = null;

/** Publish any scheduled posts whose time has arrived. */
export async function publishDuePosts(db: Database = getDb()): Promise<number> {
  const due = db
    .query("SELECT * FROM posts WHERE status = 'scheduled' AND scheduled_at <= ?")
    .all(new Date().toISOString()) as PostRow[];

  for (const post of due) {
    // Flip draft=false in the front matter.
    const raw = await readPostFile(post);
    const { frontMatter, body } = parseFrontMatter(raw);
    frontMatter.draft = false;
    const fm = { ...frontMatter, type: post.post_type, date: frontMatter.date, draft: false } as any;
    await Bun.write(
      join(CONTENT_DIR, post.file_path),
      serializeFrontMatter(fm) + "\n\n" + body.replace(/^\n+/, "") + "\n",
    );
    db.query(
      "UPDATE posts SET status = 'published', published_at = ?, scheduled_at = NULL WHERE id = ?",
    ).run(post.scheduled_at ?? new Date().toISOString(), post.id);
  }
  return due.length;
}

/** Run one scheduler tick. */
export async function tick(db: Database = getDb()): Promise<void> {
  const published = await publishDuePosts(db);
  await processPending(db);
  await processQueue(db);
  if (published > 0) scheduleFullBuild(1000);
}

export function startScheduler(intervalMs = 60_000): void {
  if (timer) return;
  // Recover any syndications stranded in 'sending' by a crash mid-dispatch.
  const recovered = resetStuckSyndications();
  if (recovered) console.log(`[scheduler] reset ${recovered} stuck syndication(s)`);
  timer = setInterval(() => {
    tick().catch((e) => console.error("[scheduler]", e));
  }, intervalMs);
  // Reply / mention polling every 2 minutes (+ once shortly after boot) so
  // comments and mentions show up quickly instead of feeling stale.
  const pollAll = () => {
    pollReplies().catch((e) => console.error("[reply-poll]", e));
    pollMentions().catch((e) => console.error("[mentions-poll]", e));
  };
  replyTimer = setInterval(pollAll, 2 * 60_000);
  setTimeout(pollAll, 8000);
  // Following-timeline refresh every 5 minutes (+ once shortly after boot).
  timelineTimer = setInterval(() => {
    refreshTimeline().catch((e) => console.error("[timeline]", e));
  }, 5 * 60_000);
  setTimeout(() => {
    refreshTimeline().catch((e) => console.error("[timeline]", e));
  }, 4000);
}

export function stopScheduler(): void {
  if (timer) clearInterval(timer);
  if (replyTimer) clearInterval(replyTimer);
  if (timelineTimer) clearInterval(timelineTimer);
  timer = null;
  replyTimer = null;
  timelineTimer = null;
}
