import { test, expect, describe } from "bun:test";
import { buildTagFacets, categoriesToTags, markdownToRichText } from "../src/services/crosspost/bluesky.ts";
import { categoriesToHashtags, appendHashtags } from "../src/services/crosspost/mastodon.ts";

describe("Bluesky hashtags", () => {
  test("buildTagFacets detects body #hashtags and skips numeric", () => {
    const text = "loving #markdown and #web3 today #1";
    const facets = buildTagFacets(text);
    const tags = facets.map((f) => f.features[0].tag);
    expect(tags).toEqual(["markdown", "web3"]);
    // The facet byte range covers the #hashtag including the hash.
    const f0 = facets[0];
    const slice = Buffer.from(text).slice(f0.index.byteStart, f0.index.byteEnd).toString();
    expect(slice).toBe("#markdown");
    // Tag features use the proper lexicon type.
    expect(facets[0].features[0].$type).toBe("app.bsky.richtext.facet#tag");
  });

  test("markdownToRichText emits a tag facet for body hashtags", () => {
    const { text, facets } = markdownToRichText("check #devlog");
    expect(text).toBe("check #devlog");
    const tagFacet = facets.find((f) => f.features[0].$type === "app.bsky.richtext.facet#tag");
    expect(tagFacet?.features[0].tag).toBe("devlog");
  });

  test("categoriesToTags strips #, spaces, dedupes, caps at 8", () => {
    expect(categoriesToTags(["#Tech", "tech", "Web Dev", ""])).toEqual(["Tech", "WebDev"]);
    const many = Array.from({ length: 12 }, (_, i) => "t" + i);
    expect(categoriesToTags(many)).toHaveLength(8);
  });
});

describe("Mastodon hashtags", () => {
  test("categoriesToHashtags formats #CamelCase tokens", () => {
    expect(categoriesToHashtags(["web dev", "#tech"])).toEqual(["#webdev", "#tech"]);
  });

  test("appendHashtags adds tags, skipping ones already written as hashtags", () => {
    // The body already contains the #tech hashtag → only #indieweb is appended.
    const out = appendHashtags("a post about #tech", ["tech", "indieweb"], 500);
    expect(out).toBe("a post about #tech\n\n#indieweb");
  });

  test("appendHashtags skips silently when there is no room", () => {
    const text = "x".repeat(498);
    expect(appendHashtags(text, ["toolong"], 500)).toBe(text);
  });

  test("appendHashtags is a no-op without categories", () => {
    expect(appendHashtags("hello", [], 500)).toBe("hello");
    expect(appendHashtags("hello", undefined, 500)).toBe("hello");
  });
});
