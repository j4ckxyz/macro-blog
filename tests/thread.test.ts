import { test, expect, describe } from "bun:test";
import { splitPostIntoThread, formatChunkForMastodon, parseBlocks } from "../src/services/crosspost/thread.ts";

describe("Thread Splitting Logic", () => {
  test("splits paragraphs at double newlines if within limit", () => {
    const text = "First paragraph.\n\nSecond paragraph.\n\nThird paragraph.";
    const chunks = splitPostIntoThread(text, 25, "https://myblog.com/post", false);
    expect(chunks).toEqual([
      "First paragraph.",
      "Second paragraph.",
      "Third paragraph."
    ]);
  });

  test("splits long paragraph into sentences", () => {
    const text = "This is a long sentence. Here is another sentence. And a third one.";
    const chunks = splitPostIntoThread(text, 26, "https://myblog.com/post", false);
    expect(chunks).toEqual([
      "This is a long sentence.",
      "Here is another sentence.",
      "And a third one."
    ]);
  });

  test("splits sentence by character limit if a single sentence exceeds limit", () => {
    const text = "Supercalifragilisticexpialidocious is a very long word indeed.";
    const chunks = splitPostIntoThread(text, 20, "https://myblog.com/post", false);
    expect(chunks).toEqual([
      "Supercalifragilistic",
      "expialidocious is a ",
      "very long word indee",
      "d."
    ]);
  });

  test("keeps code blocks intact if they fit", () => {
    const text = "Code block below:\n\n```javascript\nconst a = 1;\n```\n\nSome trailing text.";
    const chunks = splitPostIntoThread(text, 50, "https://myblog.com/post", false);
    expect(chunks.length).toBe(2);
    expect(chunks[0]).toContain("```javascript\nconst a = 1;\n```");
  });

  test("splits code blocks line by line if they exceed the limit", () => {
    const text = "```\nline1\nline2\nline3\n```";
    const chunks = splitPostIntoThread(text, 15, "https://myblog.com/post", false);
    expect(chunks.every(c => c.startsWith("```") && c.endsWith("```"))).toBe(true);
  });

  test("appends linkBack URL to the last post if space is available", () => {
    const text = "Short post.";
    const chunks = splitPostIntoThread(text, 50, "https://myblog.com/post", true);
    expect(chunks).toEqual([
      "Short post.\n\n🔗 https://myblog.com/post"
    ]);
  });

  test("creates a new post for linkBack if last post is full", () => {
    const text = "This post is exactly forty characters long."; // 43 chars
    const chunks = splitPostIntoThread(text, 45, "https://myblog.com/post", true);
    expect(chunks).toEqual([
      "This post is exactly forty characters long.",
      "🔗 https://myblog.com/post"
    ]);
  });

  test("formatChunkForMastodon preserves code blocks but strips markdown elsewhere", () => {
    const code = "```javascript\nconst x = [1];\n```";
    expect(formatChunkForMastodon(code)).toBe(code);

    const normal = "# Header\n\nThis is **bold** and *italic* with `inline code` and a [link](https://test.com).";
    expect(formatChunkForMastodon(normal)).toBe("Header\n\nThis is bold and italic with inline code and a link https://test.com.");
  });
});
