import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { rmSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { freshDb } from "./helpers.ts";
import { app } from "../src/app.ts";
import { issueToken } from "../src/lib/indieauth.ts";
import { getConfig, setConfig } from "../src/lib/config.ts";
import { saveToken } from "../src/lib/tokens.ts";
import { getDb } from "../src/db/index.ts";
import { createBackup } from "../src/services/backup.ts";

let token: string;
let server: ReturnType<typeof Bun.serve> | null = null;

beforeEach(() => {
  freshDb();
  token = issueToken({ clientId: "https://admin/", scope: "create update delete media", me: "http://127.0.0.1:3000/" });
});
afterEach(() => { server?.stop(true); server = null; });

function auth(extra: Record<string, string> = {}) {
  return { Authorization: `Bearer ${token}`, ...extra };
}

describe("Admin UI availability", () => {
  test("/admin is served by the app, independent of the Hugo build", async () => {
    for (const p of ["/admin", "/admin/"]) {
      const res = await app.request(p);
      expect(res.status).toBe(200);
      expect(await res.text()).toContain("Macroblog");
    }
  });
});

describe("Admin API: posts + config", () => {
  test("creates a post and lists it", async () => {
    const res = await app.request("/api/posts", {
      method: "POST", headers: auth({ "content-type": "application/json" }),
      body: JSON.stringify({ content: "admin made this", type: "post" }),
    });
    expect(res.status).toBe(201);
    const list = await (await app.request("/api/posts", { headers: auth() })).json();
    expect(list.posts.length).toBe(1);
  });

  test("creates a post with custom language and updates it", async () => {
    const res = await app.request("/api/posts", {
      method: "POST", headers: auth({ "content-type": "application/json" }),
      body: JSON.stringify({ content: "Bonjour", type: "post", lang: "fr" }),
    });
    expect(res.status).toBe(201);
    const created = await res.json();
    expect(created.front_matter.lang).toBe("fr");

    // Now update the language of the post
    const updateRes = await app.request(`/api/posts/${created.slug}`, {
      method: "PUT", headers: auth({ "content-type": "application/json" }),
      body: JSON.stringify({ lang: "es" }),
    });
    expect(updateRes.status).toBe(200);
    const updated = await updateRes.json();
    expect(updated.front_matter.lang).toBe("es");
  });

  test("config PUT never writes auth secrets", async () => {
    const res = await app.request("/api/config", {
      method: "PUT", headers: auth({ "content-type": "application/json" }),
      body: JSON.stringify({ auth: { password_hash: "HACKED" }, site: { title: "New Title" } }),
    });
    expect(res.status).toBe(200);
    // auth was stripped; password_hash unchanged.
    expect(getConfig().auth.password_hash).not.toBe("HACKED");
  });

  test("password change requires auth and min length", async () => {
    const short = await app.request("/api/password", {
      method: "PUT", headers: auth({ "content-type": "application/json" }), body: JSON.stringify({ password: "x" }),
    });
    expect(short.status).toBe(400);
    const noauth = await app.request("/api/password", {
      method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "longenough" }),
    });
    expect(noauth.status).toBe(401);
  });
});

describe("Admin API: unified mentions reply (Mastodon)", () => {
  test("replies to a stored Mastodon reply via the API", async () => {
    let replyBody: any = null;
    server = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/api/v1/statuses" && req.method === "POST") {
          replyBody = await req.json();
          return Response.json({ id: "999", url: "https://m.example/@me/999" });
        }
        return new Response("404", { status: 404 });
      },
    });
    const cfg = getConfig();
    cfg.crossposting.mastodon.instance_url = `http://127.0.0.1:${server.port}`;
    setConfig(cfg);
    saveToken("mastodon", { access_token: "tok", extra: { instance: `http://127.0.0.1:${server.port}` } });

    getDb()
      .query("INSERT INTO social_replies (platform, remote_id, author, content) VALUES ('mastodon', '555', 'Bob', 'hi')")
      .run();
    const row = getDb().query("SELECT * FROM social_replies").get() as any;

    const res = await app.request(`/api/mentions/${row.id}/reply`, {
      method: "POST", headers: auth({ "content-type": "application/json" }),
      body: JSON.stringify({ text: "thanks Bob!" }),
    });
    expect(res.status).toBe(200);
    expect(replyBody.in_reply_to_id).toBe("555");
    expect(replyBody.status).toBe("thanks Bob!");
    const after = getDb().query("SELECT replied FROM social_replies WHERE id = ?").get(row.id) as any;
    expect(after.replied).toBe(1);
  });
});

describe("Content import", () => {
  const importFeed = (items: any[]) =>
    app.request("/api/import", {
      method: "POST", headers: auth({ "content-type": "application/json" }),
      body: JSON.stringify({ source: "microblog", content: JSON.stringify({ version: "https://jsonfeed.org/version/1.1", items }) }),
    });

  test("future-dated imports are published (not scheduled) so they aren't hidden", async () => {
    // A record whose date parses into the future (a source/parser artefact)
    // must still be published — otherwise it's 'scheduled' and Hugo's
    // buildFuture=false drops it from the site, including the archive.
    const future = new Date(Date.now() + 5 * 365 * 24 * 3600 * 1000).toISOString();
    const res = await importFeed([
      { id: "https://x/1", content_text: "from the future", date_published: future },
      { id: "https://x/2", content_text: "from the past", date_published: "2018-03-04T10:00:00.000Z" },
    ]);
    expect(res.status).toBe(200);
    expect((await res.json()).imported).toBe(2);
    const rows = getDb().query("SELECT status, published_at FROM posts").all() as any[];
    expect(rows).toHaveLength(2);
    // Neither is scheduled, and both carry a real (non-future) published_at so
    // Hugo will build them.
    expect(rows.every((r) => r.status === "published")).toBe(true);
    expect(rows.every((r) => r.published_at && new Date(r.published_at).getTime() <= Date.now() + 1000)).toBe(true);
  });

  test("re-importing past-dated content is idempotent", async () => {
    const items = [
      { id: "https://x/1", content_text: "one", date_published: "2018-03-04T10:00:00.000Z" },
      { id: "https://x/2", content_text: "two", date_published: "2019-06-07T08:09:10.000Z" },
    ];
    expect((await (await importFeed(items)).json()).imported).toBe(2);
    // Second run dedupes on the publish second (published_at carries ms).
    expect((await (await importFeed(items)).json()).imported).toBe(0);
    expect((getDb().query("SELECT COUNT(*) c FROM posts").get() as any).c).toBe(2);
  });

  test("importing into a separate section keeps it apart and filterable", async () => {
    const res = await app.request("/api/import", {
      method: "POST", headers: auth({ "content-type": "application/json" }),
      body: JSON.stringify({
        source: "microblog", section: "Tweets",
        content: JSON.stringify({ version: "https://jsonfeed.org/version/1.1", items: [
          { id: "https://x/1", content_text: "a tweet", date_published: "2018-03-04T10:00:00.000Z" },
        ] }),
      }),
    });
    expect((await res.json()).imported).toBe(1);
    // Stored under content/tweets/ (sanitised) and surfaced by /api/sections.
    const row = getDb().query("SELECT file_path FROM posts").get() as any;
    expect(row.file_path.startsWith("tweets/")).toBe(true);
    const { sections } = await (await app.request("/api/sections", { headers: auth() })).json();
    expect(sections).toEqual([{ section: "tweets", count: 1 }]);
    const list = await (await app.request("/api/posts?section=tweets", { headers: auth() })).json();
    expect(list.posts).toHaveLength(1);
  });
});

// Build a minimal STORED (uncompressed) zip — enough for the reader, which uses
// the central directory and ignores CRCs.
function makeZip(files: Record<string, Uint8Array>): Uint8Array {
  const out: number[] = [];
  const u16 = (n: number) => [n & 255, (n >> 8) & 255];
  const u32 = (n: number) => [n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >> 24) & 255];
  const enc = new TextEncoder();
  const central: number[] = [];
  for (const [name, data] of Object.entries(files)) {
    const nb = enc.encode(name);
    const localOffset = out.length;
    out.push(0x50, 0x4b, 0x03, 0x04, ...u16(20), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(data.length), ...u32(data.length), ...u16(nb.length), ...u16(0));
    out.push(...nb, ...data);
    central.push(0x50, 0x4b, 0x01, 0x02, ...u16(20), ...u16(20), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(data.length), ...u32(data.length), ...u16(nb.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(localOffset));
    central.push(...nb);
  }
  const cdOffset = out.length;
  out.push(...central);
  out.push(0x50, 0x4b, 0x05, 0x06, ...u16(0), ...u16(0), ...u16(Object.keys(files).length), ...u16(Object.keys(files).length), ...u32(central.length), ...u32(cdOffset), ...u16(0));
  return new Uint8Array(out);
}

describe("Micro.blog Blog Archive import (zip)", () => {
  test("imports markdown posts and writes bundled uploads", async () => {
    const enc = (s: string) => new TextEncoder().encode(s);
    const zip = makeZip({
      "_index.md": enc("---\ntitle: Home\n---\n"),
      "2020/01/post.md": enc('---\ntitle: "Imported"\ndate: 2020-01-02T10:00:00Z\n---\nhello ![](https://me.micro.blog/uploads/p.jpg)'),
      "uploads/p.jpg": enc("JPEGDATA"),
    });
    const form = new FormData();
    form.set("file", new File([zip as BlobPart], "export.zip", { type: "application/zip" }));
    const res = await app.request("/api/import/archive", { method: "POST", headers: auth(), body: form });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.imported).toBe(1);
    expect(body.media).toBe(1);
    expect(getDb().query("SELECT 1 FROM posts WHERE title = 'Imported'").get()).toBeTruthy();
    // The bundled image was written into the uploads dir.
    expect(existsSync(join(process.env.MACROBLOG_UPLOADS!, "p.jpg"))).toBe(true);
  });
});

describe("Content reconcile", () => {
  test("an on-disk post with no DB row becomes manageable", async () => {
    const dir = join(process.env.MACROBLOG_HUGO_SITE!, "content", "posts");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "orphan-note.md"),
      `+++\ntitle = ""\ndate = "2021-05-06T12:00:00Z"\ntype = "post"\ndraft = false\n+++\n\nan orphaned on-disk note\n`,
    );
    expect(getDb().query("SELECT 1 FROM posts WHERE slug = 'orphan-note'").get()).toBeNull();
    const res = await app.request("/api/reconcile", { method: "POST", headers: auth() });
    expect((await res.json()).added).toBeGreaterThanOrEqual(1);
    const list = await (await app.request("/api/posts", { headers: auth() })).json();
    expect(list.posts.some((p: any) => p.slug === "orphan-note")).toBe(true);
  });
});

describe("Public site fallback", () => {
  test("a public URL returns a self-diagnosing page (not a bare 404) when unbuilt", async () => {
    // Ensure there is no build output, independent of other test files' order.
    rmSync(join(process.env.MACROBLOG_PUBLIC!, "index.html"), { force: true });
    const res = await app.request("/");
    expect(res.status).toBe(503);
    const html = await res.text();
    expect(html).toContain("isn't built yet");
    expect(html).toContain("/admin/");
  });
});

describe("Backup", () => {
  test("creates a tar.gz containing the database and content", async () => {
    getDb().query("INSERT INTO posts (slug, file_path, post_type, status) VALUES ('x','posts/x.md','post','published')").run();
    const file = await createBackup();
    expect(await Bun.file(file).exists()).toBe(true);
    const list = await new Response(Bun.spawn(["tar", "tzf", file]).stdout).text();
    expect(list).toContain("macroblog.db");
  });
});
