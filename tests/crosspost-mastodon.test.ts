import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { freshDb } from "./helpers.ts";
import { ensureApp } from "../src/routes/oauth/mastodon.ts";
import { buildStatus, crosspostMastodon } from "../src/services/crosspost/mastodon.ts";
import { getConfig, setConfig } from "../src/lib/config.ts";
import { saveToken } from "../src/lib/tokens.ts";
import { getDb } from "../src/db/index.ts";
import type { CrosspostPayload } from "../src/services/crosspost/types.ts";

let server: ReturnType<typeof Bun.serve> | null = null;
let appRegistrations = 0;
let lastStatusBody: any = null;

beforeEach(() => {
  freshDb();
  appRegistrations = 0;
  lastStatusBody = null;
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/api/v1/apps" && req.method === "POST") {
        appRegistrations++;
        return Response.json({ client_id: "cid", client_secret: "secret" });
      }
      if (url.pathname === "/api/v1/statuses" && req.method === "POST") {
        lastStatusBody = await req.json();
        return Response.json({ id: "12345", url: "https://mastodon.example/@tester/12345", uri: "x" });
      }
      return new Response("not found", { status: 404 });
    },
  });
});

afterEach(() => {
  server?.stop(true);
  server = null;
});

function base() {
  return `http://127.0.0.1:${server!.port}`;
}

describe("Mastodon app registration", () => {
  test("registers a new instance and stores credentials", async () => {
    const app = await ensureApp(base());
    expect(app.client_id).toBe("cid");
    expect(appRegistrations).toBe(1);
    const row = getDb().query("SELECT * FROM mastodon_apps WHERE instance_url = ?").get(base());
    expect(row).toBeTruthy();
  });

  test("reuses a cached registration for a known instance", async () => {
    await ensureApp(base());
    await ensureApp(base());
    expect(appRegistrations).toBe(1);
  });

  test("accepts an arbitrary (GoToSocial) instance URL without hardcoding mastodon.social", async () => {
    const gts = base() + "/"; // trailing slash, custom host
    const app = await ensureApp(gts.replace(/\/+$/, ""));
    expect(app.instance_url).toBe(base());
  });
});

describe("Mastodon posting", () => {
  test("buildStatus formats notes and articles", () => {
    const note: CrosspostPayload = { text: "hi there", url: "http://x/p", type: "post", photos: [] };
    expect(buildStatus(note)).toBe("hi there");
    const article: CrosspostPayload = { text: "body", url: "http://x/a", title: "My Title", type: "article", photos: [] };
    expect(buildStatus(article)).toContain("My Title");
    expect(buildStatus(article)).toContain("http://x/a");
  });

  test("posts a status via /api/v1/statuses", async () => {
    const cfg = getConfig();
    cfg.crossposting.mastodon.instance_url = base();
    setConfig(cfg);
    saveToken("mastodon", { access_token: "tok", extra: { instance: base() } });

    const payload: CrosspostPayload = { text: "cross-posted note", url: "http://127.0.0.1:3000/p/", type: "post", photos: [] };
    const result = await crosspostMastodon(payload);
    expect(result.remoteId).toBe("12345");
    expect(result.remoteUrl).toContain("12345");
    expect(lastStatusBody.status).toBe("cross-posted note");
    expect(lastStatusBody.visibility).toBe("public");
  });

  test("threads a long post via reply chain", async () => {
    const cfg = getConfig();
    cfg.crossposting.mastodon.instance_url = base();
    setConfig(cfg);
    saveToken("mastodon", { access_token: "tok", extra: { instance: base() } });

    const statusBodies: any[] = [];
    server?.stop(true);
    let idCounter = 1000;
    server = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/api/v1/statuses" && req.method === "POST") {
          const body = await req.json();
          statusBodies.push(body);
          const newId = String(++idCounter);
          return Response.json({ id: newId, url: `https://mastodon.example/@tester/${newId}`, uri: "x" });
        }
        return new Response("not found", { status: 404 });
      }
    });
    // Update config with the new server port
    cfg.crossposting.mastodon.instance_url = base();
    setConfig(cfg);
    saveToken("mastodon", { access_token: "tok", extra: { instance: base() } });

    const longText = "a".repeat(300) + "\n\n" + "b".repeat(300);
    const payload: CrosspostPayload = { text: longText, markdown: longText, url: "http://127.0.0.1:3000/p/", type: "post", photos: [], linkBack: true };
    
    const result = await crosspostMastodon(payload);
    expect(result.remoteId).toBe("1001");
    expect(statusBodies.length).toBe(2);
    expect(statusBodies[0].status).toBe("a".repeat(300));
    expect(statusBodies[0].in_reply_to_id).toBeUndefined();
    expect(statusBodies[1].status).toBe("b".repeat(300) + "\n\n🔗 http://127.0.0.1:3000/p/");
    expect(statusBodies[1].in_reply_to_id).toBe("1001");
  });
});
