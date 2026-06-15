import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { Glob } from "bun";
import { freshDb } from "./helpers.ts";
import { buildPostRecord, buildFacets, fetchBlueskyReplies, markdownToRichText, crosspostBluesky } from "../src/services/crosspost/bluesky.ts";
import { clientMetadata, redirectUri, refreshBlueskyToken } from "../src/routes/oauth/bluesky.ts";
import { generateDpopKeypair } from "../src/lib/dpop.ts";
import { getConfig, setConfig } from "../src/lib/config.ts";
import { saveToken, getToken } from "../src/lib/tokens.ts";
import type { CrosspostPayload } from "../src/services/crosspost/types.ts";
import { resolve } from "node:path";

let server: ReturnType<typeof Bun.serve> | null = null;
beforeEach(() => freshDb());
afterEach(() => {
  server?.stop(true);
  server = null;
});

async function session() {
  const keys = await generateDpopKeypair();
  return { accessToken: "tok", keys, pds: server ? `http://127.0.0.1:${server.port}` : "http://x", did: "did:plc:abc", handle: "tester.bsky.social" };
}

describe("Bluesky record building", () => {
  test("short note → text-only app.bsky.feed.post", async () => {
    const payload: CrosspostPayload = { text: "just a short note", url: "http://127.0.0.1:3000/p/", type: "post", photos: [] };
    const record = await buildPostRecord(payload, await session());
    expect(record.$type).toBe("app.bsky.feed.post");
    expect(record.text).toBe("just a short note");
    expect(record.embed).toBeUndefined();
    expect(typeof record.createdAt).toBe("string");
  });

  test("long article → external embed link card", async () => {
    const payload: CrosspostPayload = {
      text: "x".repeat(50),
      url: "http://127.0.0.1:3000/a/",
      title: "A Long Article",
      type: "article",
      photos: [],
    };
    const record = await buildPostRecord(payload, await session());
    expect(record.embed.$type).toBe("app.bsky.embed.external");
    expect(record.embed.external.uri).toBe("http://127.0.0.1:3000/a/");
    expect(record.text).toContain("A Long Article");
  });

  test("photo post → blob upload + images embed (real fetch)", async () => {
    let uploadHits = 0;
    server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/img.png") {
          return new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/png" } });
        }
        if (url.pathname === "/xrpc/com.atproto.repo.uploadBlob") {
          uploadHits++;
          return Response.json({ blob: { $type: "blob", ref: { $link: "bafy" }, mimeType: "image/png", size: 3 } });
        }
        return new Response("404", { status: 404 });
      },
    });
    const sess = await session();
    const payload: CrosspostPayload = {
      text: "look at this",
      url: "http://127.0.0.1:3000/ph/",
      type: "photo",
      photos: [{ url: `http://127.0.0.1:${server.port}/img.png`, alt: "a pic" }],
    };
    const record = await buildPostRecord(payload, sess);
    expect(uploadHits).toBe(1);
    expect(record.embed.$type).toBe("app.bsky.embed.images");
    expect(record.embed.images[0].alt).toBe("a pic");
    expect(record.embed.images[0].image.ref.$link).toBe("bafy");
  });

  test("video post → external embed link card (no upload, fallback)", async () => {
    const sess = await session();
    const payload: CrosspostPayload = {
      text: "watch my video",
      url: "http://127.0.0.1:3000/vid/",
      type: "photo",
      photos: [{ url: `http://127.0.0.1:3000/media/clip.mp4`, alt: "funny video" }],
    };
    const record = await buildPostRecord(payload, sess);
    expect(record.embed.$type).toBe("app.bsky.embed.external");
    expect(record.embed.external.uri).toBe("http://127.0.0.1:3000/vid/");
    expect(record.embed.external.title).toBe("Video Post");
    expect(record.embed.external.description).toBe("watch my video");
  });

  test("markdownToRichText parses links and builds facets", () => {
    const { text, facets } = markdownToRichText("see [example](https://example.com) now");
    expect(text).toBe("see example now");
    expect(facets.length).toBe(1);
    expect(facets[0].features[0].uri).toBe("https://example.com");
    expect(facets[0].index.byteStart).toBe(4);
    expect(facets[0].index.byteEnd).toBe(11);
  });

  test("link post with no media → fetches og metadata and attaches external embed", async () => {
    let metadataFetched = false;
    let uploadHits = 0;
    server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/target-page") {
          metadataFetched = true;
          return new Response(`
            <html>
              <head>
                <title>Target Title</title>
                <meta property="og:description" content="Target Description" />
                <meta property="og:image" content="http://127.0.0.1:${server.port}/og-image.jpg" />
              </head>
            </html>
          `);
        }
        if (url.pathname === "/og-image.jpg") {
          return new Response(new Uint8Array([9, 9, 9]), { headers: { "content-type": "image/jpeg" } });
        }
        if (url.pathname === "/xrpc/com.atproto.repo.uploadBlob") {
          uploadHits++;
          return Response.json({ blob: { $type: "blob", ref: { $link: "og-blob-ref" }, mimeType: "image/jpeg", size: 3 } });
        }
        return new Response("404", { status: 404 });
      },
    });

    const sess = await session();
    const payload: CrosspostPayload = {
      text: `check out [link](http://127.0.0.1:${server.port}/target-page)`,
      url: "http://127.0.0.1:3000/mypost/",
      type: "post",
      photos: [],
    };

    const record = await buildPostRecord(payload, sess);
    expect(metadataFetched).toBe(true);
    expect(uploadHits).toBe(1);
    expect(record.embed.$type).toBe("app.bsky.embed.external");
    expect(record.embed.external.uri).toBe(`http://127.0.0.1:${server.port}/target-page`);
    expect(record.embed.external.title).toBe("Target Title");
    expect(record.embed.external.description).toBe("Target Description");
    expect(record.embed.external.thumb.ref.$link).toBe("og-blob-ref");
  });

  test("buildFacets produces byte-indexed link facets", () => {
    const text = "see https://example.com now";
    const facets = buildFacets(text);
    expect(facets.length).toBe(1);
    expect(facets[0].features[0].uri).toBe("https://example.com");
    expect(facets[0].index.byteStart).toBe(4);
    expect(facets[0].index.byteEnd).toBe(4 + "https://example.com".length);
  });

  test("custom language or default language is set on the record", async () => {
    const payload1: CrosspostPayload = { text: "hello", url: "http://x", type: "post", photos: [], lang: "fr" };
    const record1 = await buildPostRecord(payload1, await session());
    expect(record1.langs).toEqual(["fr"]);

    const cfg = getConfig();
    const origLang = cfg.site.language;
    cfg.site.language = "ja";
    setConfig(cfg);
    try {
      const payload2: CrosspostPayload = { text: "hello", url: "http://x", type: "post", photos: [] };
      const record2 = await buildPostRecord(payload2, await session());
      expect(record2.langs).toEqual(["ja"]);
    } finally {
      cfg.site.language = origLang;
      setConfig(cfg);
    }
  });
});

describe("Bluesky OAuth config safety", () => {
  test("client metadata requests fine-grained scopes and DPoP, never the broad transition scope", () => {
    const meta = clientMetadata();
    // Least-privilege: base identity + post + image upload + read thread only.
    expect(meta.scope).toContain("atproto");
    expect(meta.scope).toContain("repo:app.bsky.feed.post");
    expect(meta.scope).not.toContain("transition:generic");
    // Must NOT grant follows/likes/DMs/profile/account scopes.
    expect(meta.scope).not.toContain("repo:app.bsky.graph");
    expect(meta.scope).not.toContain("repo:*");
    expect(meta.dpop_bound_access_tokens).toBe(true);
    expect(meta.token_endpoint_auth_method).toBe("none");
  });

  test("redirect URI uses 127.0.0.1, not localhost", () => {
    const cfg = getConfig();
    const original = cfg.site.url;
    cfg.site.url = "http://localhost:3000";
    setConfig(cfg);
    try {
      expect(redirectUri()).toBe("http://127.0.0.1:3000/oauth/bluesky/callback");
      expect(redirectUri()).not.toContain("localhost");
    } finally {
      cfg.site.url = original;
      setConfig(cfg);
    }
  });

  test("no 'transition:generic' scope anywhere in the codebase", async () => {
    const glob = new Glob("src/**/*.ts");
    const root = resolve(import.meta.dir, "..");
    let found = false;
    for await (const file of glob.scan({ cwd: root })) {
      const text = await Bun.file(resolve(root, file)).text();
      if (text.includes("transition:generic")) found = true;
    }
    expect(found).toBe(false);
  });
});

describe("Bluesky token refresh", () => {
  test("refreshes the access token using the refresh token + DPoP", async () => {
    let refreshHits = 0;
    server = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/token") {
          refreshHits++;
          // Require a DPoP proof header to be present.
          expect(req.headers.get("DPoP")).toBeTruthy();
          return Response.json({ access_token: "new-token", refresh_token: "new-refresh", expires_in: 3600 });
        }
        return new Response("404", { status: 404 });
      },
    });
    const keys = await generateDpopKeypair();
    saveToken("bluesky", {
      access_token: "old",
      refresh_token: "r1",
      expires_at: new Date(Date.now() - 1000).toISOString(),
      extra: {
        dpop_private_jwk: keys.privateJwk,
        dpop_public_jwk: keys.publicJwk,
        token_endpoint: `http://127.0.0.1:${server.port}/token`,
      },
    });
    await refreshBlueskyToken();
    expect(refreshHits).toBe(1);
    const tok = getToken("bluesky");
    expect(tok!.access_token).toBe("new-token");
    expect(tok!.refresh_token).toBe("new-refresh");
  });
});

describe("Bluesky crossposting thread", () => {
  test("threads a long post via reply parent/root chains", async () => {
    const postRecords: any[] = [];
    server = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/xrpc/com.atproto.repo.createRecord" && req.method === "POST") {
          const body = await req.json();
          postRecords.push(body.record);
          const rkey = `rkey-${postRecords.length}`;
          return Response.json({ uri: `at://did:plc:abc/app.bsky.feed.post/${rkey}`, cid: `cid-${postRecords.length}` });
        }
        return new Response("not found", { status: 404 });
      },
    });

    const sess = await session();
    saveToken("bluesky", {
      access_token: "tok",
      expires_at: new Date(Date.now() + 3600_000).toISOString(),
      extra: {
        dpop_private_jwk: sess.keys.privateJwk,
        dpop_public_jwk: sess.keys.publicJwk,
        pds: `http://127.0.0.1:${server.port}`,
        did: "did:plc:abc",
        handle: "tester.bsky.social",
      },
    });

    const longText = "a".repeat(200) + "\n\n" + "b".repeat(200);
    const payload: CrosspostPayload = {
      text: longText,
      markdown: longText,
      url: "http://127.0.0.1:3000/p/",
      type: "post",
      photos: [],
      linkBack: true,
    };

    const result = await crosspostBluesky(payload);
    expect(result.remoteId).toBe("at://did:plc:abc/app.bsky.feed.post/rkey-1");
    expect(postRecords.length).toBe(2);

    expect(postRecords[0].text).toBe("a".repeat(200));
    expect(postRecords[0].reply).toBeUndefined();

    expect(postRecords[1].text).toBe("b".repeat(200) + "\n\n🔗 http://127.0.0.1:3000/p/");
    expect(postRecords[1].reply.root.uri).toBe("at://did:plc:abc/app.bsky.feed.post/rkey-1");
    expect(postRecords[1].reply.root.cid).toBe("cid-1");
    expect(postRecords[1].reply.parent.uri).toBe("at://did:plc:abc/app.bsky.feed.post/rkey-1");
    expect(postRecords[1].reply.parent.cid).toBe("cid-1");
  });
});
