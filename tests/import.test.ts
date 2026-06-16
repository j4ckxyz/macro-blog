import { test, expect, describe } from "bun:test";
import {
  parseMicroblog,
  parseTwitter,
  parseRss,
  parseWordpress,
  parseInstagram,
  parseMicroblogArchive,
  parseImport,
  toIso,
  htmlToMarkdown,
} from "../src/services/import.ts";

describe("toIso date backfilling", () => {
  test("unix seconds → ISO", () => {
    expect(toIso(1577934245)).toBe("2020-01-02T03:04:05.000Z");
  });
  test("unix milliseconds → ISO", () => {
    expect(toIso(1577934245000)).toBe("2020-01-02T03:04:05.000Z");
  });
  test("WordPress GMT (no tz) treated as UTC", () => {
    expect(toIso("2020-01-02 03:04:05")).toBe("2020-01-02T03:04:05.000Z");
  });
  test("RFC822 pubDate", () => {
    expect(toIso("Thu, 02 Jan 2020 03:04:05 +0000")).toBe("2020-01-02T03:04:05.000Z");
  });
  test("Twitter created_at format", () => {
    expect(toIso("Thu Jan 02 03:04:05 +0000 2020")).toBe("2020-01-02T03:04:05.000Z");
  });
  test("empty / garbage → null (caller backfills)", () => {
    expect(toIso("")).toBeNull();
    expect(toIso("not a date")).toBeNull();
    expect(toIso(undefined)).toBeNull();
  });
});

describe("htmlToMarkdown", () => {
  test("links, emphasis, entities", () => {
    const md = htmlToMarkdown('<p>Hello <strong>world</strong> &amp; <a href="https://x.com">x</a></p>');
    expect(md).toBe("Hello **world** & [x](https://x.com)");
  });
});

describe("parseMicroblog (JSON Feed)", () => {
  const feed = {
    items: [
      {
        title: "An Article",
        content_html: "<p>Body <strong>text</strong></p>",
        date_published: "2021-05-06T07:08:09Z",
        url: "https://me.example/a",
        tags: ["tech"],
      },
      {
        content_text: "just a note",
        date_published: "2021-05-07T00:00:00Z",
        attachments: [{ url: "https://me.example/p.jpg", mime_type: "image/jpeg", title: "alt" }],
      },
    ],
  };
  test("preserves original dates and types", () => {
    const recs = parseMicroblog(feed);
    expect(recs).toHaveLength(2);
    expect(recs[0].type).toBe("article");
    expect(recs[0].title).toBe("An Article");
    expect(recs[0].content).toBe("Body **text**");
    expect(recs[0].date).toBe("2021-05-06T07:08:09.000Z");
    expect(recs[0].categories).toEqual(["tech"]);
    // Second item has an image attachment → photo post.
    expect(recs[1].type).toBe("photo");
    expect(recs[1].photos[0]).toEqual({ url: "https://me.example/p.jpg", alt: "alt" });
    expect(recs[1].date).toBe("2021-05-07T00:00:00.000Z");
  });
  test("accepts a JSON string too", () => {
    const recs = parseMicroblog(JSON.stringify(feed));
    expect(recs).toHaveLength(2);
  });
});

describe("parseTwitter (archive)", () => {
  const archive =
    "window.YTD.tweets.part0 = " +
    JSON.stringify([
      {
        tweet: {
          id_str: "123",
          created_at: "Thu Jan 02 03:04:05 +0000 2020",
          full_text: "Check this out https://t.co/abc and a pic https://t.co/pic",
          entities: { urls: [{ url: "https://t.co/abc", expanded_url: "https://example.com/post" }] },
          extended_entities: {
            media: [{ url: "https://t.co/pic", media_url_https: "https://pbs.twimg.com/m.jpg", type: "photo", ext_alt_text: "a pic" }],
          },
        },
      },
      { tweet: { id_str: "2", created_at: "Thu Jan 02 03:04:05 +0000 2020", full_text: "RT @someone: not mine" } },
    ]);

  test("expands links, attaches media, strips media t.co, backfills date, skips RTs", () => {
    const recs = parseTwitter(archive);
    expect(recs).toHaveLength(1); // retweet skipped
    const r = recs[0];
    expect(r.content).toBe("Check this out https://example.com/post and a pic");
    expect(r.type).toBe("photo");
    expect(r.photos[0]).toEqual({ url: "https://pbs.twimg.com/m.jpg", alt: "a pic" });
    expect(r.date).toBe("2020-01-02T03:04:05.000Z");
    expect(r.sourceUrl).toContain("123");
  });

  test("keeps only original tweets — skips replies, RTs and blanks", () => {
    const recs = parseTwitter(
      JSON.stringify([
        { tweet: { id_str: "1", created_at: "Thu Jan 02 03:04:05 +0000 2020", full_text: "an original" } },
        { tweet: { id_str: "2", created_at: "Thu Jan 02 03:04:05 +0000 2020", full_text: "@bob a reply", in_reply_to_user_id_str: "9" } },
        { tweet: { id_str: "3", created_at: "Thu Jan 02 03:04:05 +0000 2020", full_text: "@carol mention-reply with no field" } },
        { tweet: { id_str: "4", created_at: "Thu Jan 02 03:04:05 +0000 2020", full_text: "   " } },
        { tweet: { id_str: "5", created_at: "Thu Jan 02 03:04:05 +0000 2020", full_text: "RT @x: nope" } },
      ]),
    );
    expect(recs.map((r) => r.content)).toEqual(["an original"]);
  });
});

describe("parseMicroblogArchive (Hugo Markdown export)", () => {
  const enc = (s: string) => new TextEncoder().encode(s);
  test("imports posts, skips indexes/blanks, rewrites uploads, collects media", () => {
    const entries = [
      { path: "_index.md", data: enc("---\ntitle: Home\n---\n") },
      { path: "2020/01/article.md", data: enc('---\ntitle: "Hi"\ndate: 2020-01-02T10:00:00Z\ncategories:\n  - tech\n---\nbody ![](https://me.micro.blog/uploads/p.jpg)') },
      { path: "2020/03/micro.md", data: enc("---\ndate: 2020-03-04T08:00:00Z\n---\njust a micropost #tag") },
      { path: "2020/04/blank.md", data: enc("---\ndate: 2020-04-04T08:00:00Z\n---\n") },
      { path: "pages/about.md", data: enc("---\ntitle: About\ndate: 2019-01-01T00:00:00Z\n---\npage") },
      { path: "uploads/p.jpg", data: enc("JPEGDATA") },
    ];
    const { records, uploads } = parseMicroblogArchive(entries);
    expect(records).toHaveLength(2); // index, blank and page skipped
    const article = records.find((r) => r.title === "Hi")!;
    expect(article.type).toBe("article");
    expect(article.categories).toEqual(["tech"]);
    expect(article.content).toContain("/uploads/p.jpg"); // absolute URL rewritten
    const micro = records.find((r) => !r.title)!;
    expect(micro.type).toBe("post");
    expect(uploads.map((u) => u.path)).toEqual(["p.jpg"]);
  });
});

describe("parseRss (RSS 2.0 + Atom)", () => {
  test("RSS 2.0 item with content:encoded and pubDate", () => {
    const xml = `<rss><channel>
      <item>
        <title>Post One</title>
        <link>https://blog.example/one</link>
        <pubDate>Thu, 02 Jan 2020 03:04:05 +0000</pubDate>
        <category>news</category>
        <content:encoded><![CDATA[<p>Hello <em>there</em></p>]]></content:encoded>
      </item>
    </channel></rss>`;
    const recs = parseRss(xml);
    expect(recs).toHaveLength(1);
    expect(recs[0].title).toBe("Post One");
    expect(recs[0].content).toBe("Hello _there_");
    expect(recs[0].date).toBe("2020-01-02T03:04:05.000Z");
    expect(recs[0].categories).toEqual(["news"]);
    expect(recs[0].sourceUrl).toBe("https://blog.example/one");
  });
  test("Atom entry with published and link href", () => {
    const xml = `<feed xmlns="http://www.w3.org/2005/Atom">
      <entry>
        <title>Atom Post</title>
        <link href="https://blog.example/atom" rel="alternate"/>
        <published>2020-01-02T03:04:05Z</published>
        <content type="html">&lt;p&gt;Body&lt;/p&gt;</content>
      </entry>
    </feed>`;
    const recs = parseRss(xml);
    const atom = recs.find((r) => r.title === "Atom Post");
    expect(atom).toBeTruthy();
    expect(atom!.date).toBe("2020-01-02T03:04:05.000Z");
    expect(atom!.sourceUrl).toBe("https://blog.example/atom");
  });
});

describe("parseWordpress (WXR)", () => {
  const xml = `<rss xmlns:wp="http://wordpress.org/export/1.2/" xmlns:content="http://purl.org/rss/1.0/modules/content/">
    <channel>
      <item>
        <title>Published Post</title>
        <link>https://wp.example/p</link>
        <content:encoded><![CDATA[<p>WP body</p>]]></content:encoded>
        <wp:post_date_gmt>2019-03-04 05:06:07</wp:post_date_gmt>
        <wp:status>publish</wp:status>
        <wp:post_type>post</wp:post_type>
        <category domain="category" nicename="life"><![CDATA[Life]]></category>
      </item>
      <item>
        <title>A Draft</title>
        <wp:status>draft</wp:status>
        <wp:post_type>post</wp:post_type>
      </item>
      <item>
        <title>An Attachment</title>
        <wp:post_type>attachment</wp:post_type>
      </item>
    </channel>
  </rss>`;

  test("imports only published posts with GMT dates backfilled as UTC", () => {
    const recs = parseWordpress(xml);
    expect(recs).toHaveLength(1);
    expect(recs[0].title).toBe("Published Post");
    expect(recs[0].content).toBe("WP body");
    expect(recs[0].date).toBe("2019-03-04T05:06:07.000Z");
    expect(recs[0].categories).toContain("Life");
  });
});

describe("parseInstagram (archive)", () => {
  test("media + caption + unix timestamp → photo post with original date", () => {
    const data = [
      {
        title: "beach day",
        creation_timestamp: 1577934245,
        media: [{ uri: "media/posts/1.jpg", title: "" }],
      },
    ];
    const recs = parseInstagram(data);
    expect(recs).toHaveLength(1);
    expect(recs[0].type).toBe("photo");
    expect(recs[0].content).toBe("beach day");
    expect(recs[0].photos[0].url).toBe("media/posts/1.jpg");
    expect(recs[0].date).toBe("2020-01-02T03:04:05.000Z");
  });
  test("timestamp may live on the media entry", () => {
    const data = { media: [{ uri: "x.jpg", creation_timestamp: 1577934245, title: "hi" }] };
    const recs = parseInstagram(data);
    expect(recs[0].date).toBe("2020-01-02T03:04:05.000Z");
  });
});

describe("parseImport dispatcher", () => {
  test("routes by source", () => {
    expect(parseImport("microblog", { items: [] })).toEqual([]);
    expect(() => parseImport("nope" as any, "")).toThrow();
  });
});
