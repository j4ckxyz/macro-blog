import { test, expect, describe, beforeEach } from "bun:test";
import { freshDb } from "./helpers.ts";
import { slugify, buildSlug } from "../src/lib/slugify.ts";
import {
  createPost,
  serializeFrontMatter,
  parseFrontMatter,
  type FrontMatter,
} from "../src/services/content.ts";
import type { MicropubCreate } from "../src/lib/micropub-parser.ts";

function create(partial: Partial<MicropubCreate>): MicropubCreate {
  return {
    action: "create",
    type: "post",
    content: "",
    categories: [],
    photos: [],
    status: "published",
    syndicateTo: [],
    properties: {},
    ...partial,
  };
}

describe("slugify", () => {
  test("slugifies titles", () => {
    expect(slugify("Hello, World!")).toBe("hello-world");
    expect(slugify("  Trailing--Spaces  ")).toBe("trailing-spaces");
    expect(slugify("Accénts and Ümlauts")).toBe("accents-and-umlauts");
  });

  test("titled posts use the title slug", () => {
    expect(buildSlug({ title: "My Great Post" })).toBe("my-great-post");
  });

  test("untitled posts get a time + random slug (no spaces)", () => {
    const s = buildSlug({ title: "", date: new Date("2026-06-14T20:30:15Z") });
    expect(s).toMatch(/^203015-[0-9a-f]{2}$/);
  });

  test("collision avoidance appends a counter", () => {
    const taken = new Set(["my-post"]);
    const s = buildSlug({ title: "My Post" }, (slug) => taken.has(slug));
    expect(s).toBe("my-post-2");
  });
});

describe("front matter round-trip", () => {
  test("serialises and parses back the same values", () => {
    const fm: FrontMatter = {
      title: "Hello",
      date: "2026-06-14T20:00:00Z",
      type: "article",
      categories: ["a", "b"],
      draft: false,
      syndication: ["https://bsky.app/x"],
    };
    const text = serializeFrontMatter(fm) + "\n\nBody text here.";
    const parsed = parseFrontMatter(text);
    expect(parsed.frontMatter.title).toBe("Hello");
    expect(parsed.frontMatter.type).toBe("article");
    expect(parsed.frontMatter.categories).toEqual(["a", "b"]);
    expect(parsed.frontMatter.draft).toBe(false);
    expect(parsed.frontMatter.syndication).toEqual(["https://bsky.app/x"]);
    expect(parsed.body.trim()).toBe("Body text here.");
  });
});

describe("createPost", () => {
  beforeEach(() => freshDb());

  test("each post type produces the correct type field and directory", async () => {
    const cases: Array<[MicropubCreate["type"], string]> = [
      ["post", "posts"],
      ["article", "articles"],
      ["photo", "photos"],
      ["reply", "replies"],
      ["bookmark", "bookmarks"],
    ];
    for (const [type, dir] of cases) {
      const written = await createPost(
        create({ type, content: "x", name: type === "article" ? "Title" : undefined }),
      );
      expect(written.filePath.startsWith(dir + "/")).toBe(true);
      expect(written.frontMatter.type).toBe(type);
      const file = await Bun.file(written.absPath).text();
      expect(file).toContain(`type = "${type}"`);
    }
  });

  test("draft posts are written with draft = true", async () => {
    const written = await createPost(create({ content: "draft me", status: "draft" }));
    const file = await Bun.file(written.absPath).text();
    expect(file).toContain("draft = true");
  });

  test("permalink uses date path + slug", async () => {
    const written = await createPost(
      create({ name: "Hello World", content: "x", type: "article", published: "2026-06-14T20:00:00Z" }),
    );
    expect(written.permalink).toBe("http://127.0.0.1:3000/2026/06/14/hello-world/");
  });
});
