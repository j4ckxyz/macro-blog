import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { freshDb } from "./helpers.ts";
import { app } from "../src/app.ts";
import { verifyWebmention, parseSource } from "../src/routes/webmention.ts";
import { discoverEndpoint, sendOne, extractLinks } from "../src/services/webmention-send.ts";
import { getDb } from "../src/db/index.ts";

let server: ReturnType<typeof Bun.serve> | null = null;

beforeEach(() => freshDb());
afterEach(() => {
  server?.stop(true);
  server = null;
});

describe("Webmention receive (validation)", () => {
  test("missing source returns 400", async () => {
    const res = await app.request("/webmention", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ target: "http://127.0.0.1:3000/x/" }).toString(),
    });
    expect(res.status).toBe(400);
  });

  test("target not on this domain returns 400", async () => {
    const res = await app.request("/webmention", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        source: "https://other.example/post",
        target: "https://not-my-domain.example/x/",
      }).toString(),
    });
    expect(res.status).toBe(400);
  });

  test("valid request is accepted (202)", async () => {
    const res = await app.request("/webmention", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        source: "https://other.example/post",
        target: "http://127.0.0.1:3000/2026/06/14/hi/",
      }).toString(),
    });
    expect(res.status).toBe(202);
  });
});

describe("Webmention verification (real fetch against a test server)", () => {
  test("a source linking back is stored as a reply", async () => {
    const target = "http://127.0.0.1:3000/2026/06/14/hello/";
    server = Bun.serve({
      port: 0,
      fetch() {
        const html = `<!DOCTYPE html><html><body>
          <div class="h-entry">
            <a class="p-author h-card" href="https://alice.example">Alice</a>
            <a class="u-in-reply-to" href="${target}">re</a>
            <div class="e-content">Nice post!</div>
          </div></body></html>`;
        return new Response(html, { headers: { "content-type": "text/html" } });
      },
    });
    const source = `http://127.0.0.1:${server.port}/reply`;
    const ok = await verifyWebmention(source, target);
    expect(ok).toBe(true);

    const row = getDb().query("SELECT * FROM webmentions WHERE source = ?").get(source) as any;
    expect(row).toBeTruthy();
    expect(row.type).toBe("reply");
    expect(row.author_name).toBe("Alice");
    expect(row.status).toBe("pending"); // moderation on in test config
  });

  test("a source that does not link back is rejected", async () => {
    const target = "http://127.0.0.1:3000/2026/06/14/hello/";
    server = Bun.serve({
      port: 0,
      fetch() {
        return new Response("<html><body>no links here</body></html>", { headers: { "content-type": "text/html" } });
      },
    });
    const source = `http://127.0.0.1:${server.port}/nolink`;
    const ok = await verifyWebmention(source, target);
    expect(ok).toBe(false);
  });
});

describe("parseSource type detection", () => {
  test("detects like-of", () => {
    const target = "http://127.0.0.1:3000/p/";
    const html = `<div class="h-entry"><a class="u-like-of" href="${target}">like</a></div>`;
    expect(parseSource(html, "https://s.example", target).type).toBe("like");
  });
});

describe("Outgoing webmentions", () => {
  test("extractLinks finds external markdown links", () => {
    const links = extractLinks("Check [this](https://example.com/a) and <https://example.com/b>");
    expect(links).toContain("https://example.com/a");
    expect(links).toContain("https://example.com/b");
  });

  test("discovers endpoint and sends (real fetch against a test server)", async () => {
    let received: { source?: string; target?: string } = {};
    server = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/wm" && req.method === "POST") {
          const body = new URLSearchParams(await req.text());
          received = { source: body.get("source")!, target: body.get("target")! };
          return new Response("ok", { status: 202 });
        }
        return new Response(
          `<html><head><link rel="webmention" href="/wm" /></head><body>post</body></html>`,
          { headers: { "content-type": "text/html" } },
        );
      },
    });
    const target = `http://127.0.0.1:${server.port}/post`;
    const endpoint = await discoverEndpoint(target);
    expect(endpoint).toBe(`http://127.0.0.1:${server.port}/wm`);

    const ok = await sendOne("http://127.0.0.1:3000/mine/", target);
    expect(ok).toBe(true);
    expect(received.source).toBe("http://127.0.0.1:3000/mine/");
    expect(received.target).toBe(target);
  });
});
