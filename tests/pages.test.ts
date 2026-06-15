import { test, expect, describe, beforeEach } from "bun:test";
import { join } from "node:path";
import { freshDb } from "./helpers.ts";
import { app } from "../src/app.ts";
import { issueToken } from "../src/lib/indieauth.ts";
import { createPage, listPages, getPageRow, readPage, updatePage, deletePage } from "../src/services/pages.ts";
import { CONTENT_DIR } from "../src/services/content.ts";

let token: string;
beforeEach(() => {
  freshDb();
  token = issueToken({ clientId: "https://a/", scope: "create update delete", me: "http://127.0.0.1:3000/" });
});
const auth = () => ({ Authorization: `Bearer ${token}`, "content-type": "application/json" });

describe("pages service", () => {
  test("create writes a page file + DB row with the right front matter", async () => {
    const row = await createPage({ title: "About Me", content: "Hello there.", showInNav: true, weight: 1 });
    expect(row.post_type).toBe("page");
    expect(row.slug).toBe("about-me");
    const file = await Bun.file(join(CONTENT_DIR, row.file_path)).text();
    expect(file).toContain('type = "page"');
    expect(file).toContain('url = "/about-me/"');
    expect(file).toContain("show_in_nav = true");
    expect(file).toContain("Hello there.");
  });

  test("list / read / update / delete round-trip", async () => {
    const row = await createPage({ title: "Colophon", content: "v1", showInNav: false });
    expect(listPages().length).toBe(1);

    const read = await readPage(getPageRow("colophon")!);
    expect(read.title).toBe("Colophon");
    expect(read.content).toBe("v1");
    expect(read.showInNav).toBe(false);

    await updatePage(row, { title: "Colophon", content: "v2 updated", showInNav: true, weight: 2 });
    const read2 = await readPage(getPageRow("colophon")!);
    expect(read2.content).toBe("v2 updated");
    expect(read2.showInNav).toBe(true);

    await deletePage(getPageRow("colophon")!);
    expect(getPageRow("colophon")).toBeNull();
    expect(await Bun.file(join(CONTENT_DIR, row.file_path)).exists()).toBe(false);
  });
});

describe("pages admin API", () => {
  test("CRUD via the API", async () => {
    const create = await app.request("/api/pages", {
      method: "POST", headers: auth(), body: JSON.stringify({ title: "Now", content: "doing things", show_in_nav: true }),
    });
    expect(create.status).toBe(201);
    const { slug, url } = await create.json();
    expect(slug).toBe("now");
    expect(url).toBe("http://127.0.0.1:3000/now/");

    const list = await (await app.request("/api/pages", { headers: auth() })).json();
    expect(list.pages.some((p: any) => p.slug === "now" && p.show_in_nav)).toBe(true);

    const put = await app.request("/api/pages/now", { method: "PUT", headers: auth(), body: JSON.stringify({ title: "Now", content: "updated", show_in_nav: false }) });
    expect(put.status).toBe(200);

    const del = await app.request("/api/pages/now", { method: "DELETE", headers: auth() });
    expect(del.status).toBe(200);
    expect((await (await app.request("/api/pages", { headers: auth() })).json()).pages.length).toBe(0);
  });

  test("config exposes appearance and accepts updates", async () => {
    const cfg = await (await app.request("/api/config", { headers: auth() })).json();
    expect(cfg.appearance).toBeDefined();
    const put = await app.request("/api/config", {
      method: "PUT", headers: auth(),
      body: JSON.stringify({ appearance: { font: "serif", mode: "dark", light_accent: "#cc3300", dark_background: "#101418" } }),
    });
    expect(put.status).toBe(200);
    const after = await put.json();
    expect(after.appearance.font).toBe("serif");
    expect(after.appearance.mode).toBe("dark");
    expect(after.appearance.light_accent).toBe("#cc3300");
    expect(after.appearance.dark_background).toBe("#101418");
  });
});
