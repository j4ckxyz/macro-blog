import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { freshDb } from "./helpers.ts";
import { app } from "../src/app.ts";
import { getConfig, setConfig } from "../src/lib/config.ts";
import { saveToken, needsReauth, getTokenExtra } from "../src/lib/tokens.ts";
import { generateDpopKeypair } from "../src/lib/dpop.ts";
import { refreshTimeline, getTimeline } from "../src/services/timeline.ts";
import { fetchMastodonHomeTimeline } from "../src/services/crosspost/mastodon.ts";
import { issueToken } from "../src/lib/indieauth.ts";

let server: ReturnType<typeof Bun.serve> | null = null;
beforeEach(() => freshDb());
afterEach(() => { server?.stop(true); server = null; });

async function connectBluesky(pds: string) {
  const keys = await generateDpopKeypair();
  saveToken("bluesky", {
    access_token: "tok",
    expires_at: new Date(Date.now() + 3600_000).toISOString(),
    extra: { dpop_private_jwk: keys.privateJwk, dpop_public_jwk: keys.publicJwk, pds, did: "did:plc:me", handle: "me.bsky.social" },
  });
  const cfg = getConfig();
  cfg.crossposting.bluesky.enabled = true;
  setConfig(cfg);
}

function connectMastodon(base: string) {
  saveToken("mastodon", { access_token: "tok", extra: { instance: base } });
  const cfg = getConfig();
  cfg.crossposting.mastodon.enabled = true;
  cfg.crossposting.mastodon.instance_url = base;
  setConfig(cfg);
}

describe("Mastodon home timeline", () => {
  test("normalizes statuses and reblogs", async () => {
    server = Bun.serve({
      port: 0,
      fetch(req) {
        if (new URL(req.url).pathname === "/api/v1/timelines/home") {
          return Response.json([
            { id: "1", url: "https://m/1", created_at: "2026-06-15T10:00:00Z",
              account: { display_name: "Bob", acct: "bob", avatar: "a.png" },
              content: "<p>hello <b>world</b></p>", media_attachments: [] },
            { id: "2", created_at: "2026-06-15T09:00:00Z",
              account: { display_name: "Me", acct: "me" },
              reblog: { url: "https://m/orig", created_at: "2026-06-15T08:00:00Z",
                account: { display_name: "Carol", acct: "carol" }, content: "<p>boosted</p>", media_attachments: [] } },
          ]);
        }
        return new Response("404", { status: 404 });
      },
    });
    connectMastodon(`http://127.0.0.1:${server.port}`);
    const items = await fetchMastodonHomeTimeline();
    expect(items.length).toBe(2);
    expect(items[0].author).toBe("Bob");
    expect(items[0].authorHandle).toBe("@bob");
    expect(items[0].content).toBe("hello world"); // html stripped
    expect(items[1].repostedBy).toBe("Me");
    expect(items[1].author).toBe("Carol");
  });

  test("a 401 flags reauth", async () => {
    server = Bun.serve({ port: 0, fetch() { return new Response("nope", { status: 401 }); } });
    connectMastodon(`http://127.0.0.1:${server.port}`);
    await expect(fetchMastodonHomeTimeline()).rejects.toThrow();
    expect(needsReauth("mastodon")).toBe(true);
  });
});

describe("Bluesky timeline", () => {
  test("getTimeline normalizes feed items and reposts", async () => {
    let proxyHeader: string | null = null;
    server = Bun.serve({
      port: 0,
      fetch(req) {
        if (new URL(req.url).pathname === "/xrpc/app.bsky.feed.getTimeline") {
          proxyHeader = req.headers.get("atproto-proxy");
          return Response.json({ feed: [
            { post: { uri: "at://did:plc:a/app.bsky.feed.post/abc", cid: "c1",
              author: { handle: "alice.bsky.social", displayName: "Alice", avatar: "a.png" },
              record: { text: "hi from bsky", createdAt: "2026-06-15T10:00:00Z" } } },
            { post: { uri: "at://did:plc:b/app.bsky.feed.post/xyz", cid: "c2",
              author: { handle: "carol.dev", displayName: "Carol" },
              record: { text: "reposted", createdAt: "2026-06-15T09:00:00Z" } },
              reason: { $type: "app.bsky.feed.defs#reasonRepost", by: { displayName: "Dave" } } },
          ] });
        }
        return new Response("404", { status: 404 });
      },
    });
    await connectBluesky(`http://127.0.0.1:${server.port}`);
    const { fetchBlueskyTimeline } = await import("../src/services/crosspost/bluesky.ts");
    const items = await fetchBlueskyTimeline();
    expect(proxyHeader === "did:web:api.bsky.app#bsky_appview").toBe(true); // proxied to AppView
    expect(items.length).toBe(2);
    expect(items[0].author).toBe("Alice");
    expect(items[0].authorHandle).toBe("@alice.bsky.social");
    expect(items[0].url).toContain("bsky.app/profile/alice.bsky.social/post/abc");
    expect(items[1].repostedBy).toBe("Dave");
  });
});

describe("refreshTimeline + cache", () => {
  test("merges both platforms into the cache, newest first", async () => {
    server = Bun.serve({
      port: 0,
      fetch(req) {
        const p = new URL(req.url).pathname;
        if (p === "/api/v1/timelines/home") {
          return Response.json([{ id: "m1", url: "https://m/1", created_at: "2026-06-15T09:00:00Z",
            account: { display_name: "MastoUser", acct: "m" }, content: "<p>masto</p>", media_attachments: [] }]);
        }
        if (p === "/xrpc/app.bsky.feed.getTimeline") {
          return Response.json({ feed: [{ post: { uri: "at://did:plc:a/app.bsky.feed.post/abc", cid: "c1",
            author: { handle: "alice.bsky.social", displayName: "Alice" },
            record: { text: "bsky newest", createdAt: "2026-06-15T11:00:00Z" } } }] });
        }
        return new Response("404", { status: 404 });
      },
    });
    const base = `http://127.0.0.1:${server.port}`;
    await connectBluesky(base);
    connectMastodon(base);

    const res = await refreshTimeline();
    expect(res.bluesky).toBe(1);
    expect(res.mastodon).toBe(1);

    const cached = getTimeline();
    expect(cached.length).toBe(2);
    expect(cached[0].content).toBe("bsky newest"); // newest first
    expect(cached[1].author).toBe("MastoUser");
  });
});

describe("Admin /api/timeline", () => {
  test("returns cached items and reauth flags", async () => {
    const token = issueToken({ clientId: "https://a/", scope: "create", me: "http://127.0.0.1:3000/" });
    saveToken("bluesky", { access_token: "t", extra: { needs_reauth: true, handle: "me.bsky.social" } });
    const res = await app.request("/api/timeline", { headers: { Authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(Array.isArray(json.items)).toBe(true);
    expect(json.bluesky.connected).toBe(true);
    expect(json.bluesky.needs_reauth).toBe(true);
  });
});
