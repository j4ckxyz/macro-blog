import { test, expect, describe, beforeEach, afterEach } from "bun:test";
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

describe("Backup", () => {
  test("creates a tar.gz containing the database and content", async () => {
    getDb().query("INSERT INTO posts (slug, file_path, post_type, status) VALUES ('x','posts/x.md','post','published')").run();
    const file = await createBackup();
    expect(await Bun.file(file).exists()).toBe(true);
    const list = await new Response(Bun.spawn(["tar", "tzf", file]).stdout).text();
    expect(list).toContain("macroblog.db");
  });
});
