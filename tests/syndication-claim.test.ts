import { test, expect, describe } from "bun:test";
import { freshDb } from "./helpers.ts";
import { getDb } from "../src/db/index.ts";
import { createPost } from "../src/services/content.ts";
import { queueSyndication, processPending, resetStuckSyndications } from "../src/services/syndication.ts";

describe("syndication claiming (double cross-post guard)", () => {
  test("two concurrent processPending calls dispatch a row only once", async () => {
    freshDb();
    const db = getDb();
    const written = await createPost({
      action: "create", type: "post", content: "hello world", categories: [],
      photos: [], status: "published", syndicateTo: [], properties: {},
      published: "2026-06-15T12:00:00Z",
    });
    const post = db.query("SELECT * FROM posts WHERE slug = ?").get(written.slug) as any;
    queueSyndication(post.id, ["bluesky"], db);

    // Kick off two passes without awaiting in between — mirrors the
    // post-publish dispatch racing the scheduler tick. The atomic claim must
    // ensure exactly one of them picks up the single pending row.
    const p1 = processPending(db);
    const p2 = processPending(db);
    const [n1, n2] = await Promise.all([p1, p2]);
    expect(n1 + n2).toBe(1);

    // And the row is terminal (failed: no Bluesky token in tests), not stuck.
    const syn = db.query("SELECT status FROM syndications WHERE post_id = ?").get(post.id) as any;
    expect(["failed", "success"]).toContain(syn.status);
  });

  test("resetStuckSyndications re-pends rows stranded in 'sending'", () => {
    freshDb();
    const db = getDb();
    db.query("INSERT INTO posts (slug, file_path, post_type, status) VALUES ('p','p.md','post','published')").run();
    const post = db.query("SELECT id FROM posts WHERE slug='p'").get() as any;
    db.query("INSERT INTO syndications (post_id, platform, status) VALUES (?, 'bluesky', 'sending')").run(post.id);
    expect(resetStuckSyndications(db)).toBe(1);
    const syn = db.query("SELECT status FROM syndications WHERE post_id = ?").get(post.id) as any;
    expect(syn.status).toBe("pending");
  });
});
