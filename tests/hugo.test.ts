import { test, expect, describe, beforeAll } from "bun:test";
import { join } from "node:path";
import { freshDb } from "./helpers.ts";
import { createPost } from "../src/services/content.ts";
import { fullBuild, PUBLIC_DIR } from "../src/services/hugo.ts";
import type { MicropubCreate } from "../src/lib/micropub-parser.ts";

function create(partial: Partial<MicropubCreate>): MicropubCreate {
  return {
    action: "create", type: "post", content: "", categories: [],
    photos: [], status: "published", syndicateTo: [], properties: {}, ...partial,
  };
}

let built = false;

beforeAll(async () => {
  freshDb();
  await createPost(create({ content: "A microblog note for the build test.", published: "2026-06-14T12:00:00Z" }));
  await createPost(
    create({ type: "article", name: "Hello Article", content: "Some long-form content.", published: "2026-06-13T12:00:00Z" }),
  );
  // A post imported into a custom section must stay out of the main feeds.
  await createPost(create({ content: "An imported tweet body.", section: "tweets", published: "2020-01-02T12:00:00Z" }));
  await fullBuild();
  built = true;
});

describe("Hugo build output", () => {
  test("build completes and emits index.html", async () => {
    expect(built).toBe(true);
    expect(await Bun.file(join(PUBLIC_DIR, "index.html")).exists()).toBe(true);
  });

  test("emits a valid JSON Feed 1.1", async () => {
    const feed = await Bun.file(join(PUBLIC_DIR, "feed.json")).json();
    expect(feed.version).toBe("https://jsonfeed.org/version/1.1");
    expect(feed.title).toBeTruthy();
    expect(feed.feed_url).toContain("/feed.json");
    expect(feed.author.name).toBeTruthy();
    expect(Array.isArray(feed.items)).toBe(true);
    expect(feed.items.length).toBeGreaterThanOrEqual(2);
    expect(feed.items[0].id).toContain("http");
    expect(feed.items[0].content_html).toBeTruthy();
  });

  test("emits an RSS feed at feed.xml", async () => {
    const rss = await Bun.file(join(PUBLIC_DIR, "feed.xml")).text();
    expect(rss).toContain("<rss");
    expect(rss).toContain("<channel>");
  });

  test("custom sections are kept out of the main feeds but get their own page", async () => {
    const rss = await Bun.file(join(PUBLIC_DIR, "feed.xml")).text();
    const json = await Bun.file(join(PUBLIC_DIR, "feed.json")).json();
    expect(rss).not.toContain("imported tweet body");
    expect(JSON.stringify(json.items)).not.toContain("imported tweet body");
    // The section still renders its own list page.
    expect(await Bun.file(join(PUBLIC_DIR, "tweets", "index.html")).exists()).toBe(true);
  });

  test("post pages carry microformats2 classes", async () => {
    const html = await Bun.file(join(PUBLIC_DIR, "2026", "06", "13", "hello-article", "index.html")).text();
    expect(html).toContain("h-entry");
    expect(html).toContain("e-content");
    expect(html).toContain("dt-published");
    expect(html).toContain("u-url");
  });

  test("head contains IndieWeb discovery link tags", async () => {
    const html = await Bun.file(join(PUBLIC_DIR, "index.html")).text();
    expect(html).toContain('rel="authorization_endpoint"');
    expect(html).toContain('rel="token_endpoint"');
    expect(html).toContain('rel="micropub"');
    expect(html).toContain('rel="webmention"');
    expect(html).toContain('type="application/json"');
  });
});
