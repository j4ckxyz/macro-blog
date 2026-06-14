import { test, expect, describe, beforeEach } from "bun:test";
import { freshDb } from "./helpers.ts";
import { app } from "../src/app.ts";
import { issueToken } from "../src/lib/indieauth.ts";
import { getDb } from "../src/db/index.ts";

let token: string;

beforeEach(() => {
  freshDb();
  token = issueToken({ clientId: "https://client.example/", scope: "create update delete media", me: "http://127.0.0.1:3000/" });
});

function authHeaders(extra: Record<string, string> = {}) {
  return { Authorization: `Bearer ${token}`, ...extra };
}

describe("Micropub GET", () => {
  test("q=config returns capabilities", async () => {
    const res = await app.request("/micropub?q=config", { headers: authHeaders() });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json["media-endpoint"]).toBe("http://127.0.0.1:3000/media");
    expect(Array.isArray(json["syndicate-to"])).toBe(true);
    expect(json["syndicate-to"].some((s: any) => s.uid === "bluesky")).toBe(true);
    expect(json["post-types"].some((p: any) => p.type === "note")).toBe(true);
  });

  test("without auth returns 401", async () => {
    const res = await app.request("/micropub?q=config");
    expect(res.status).toBe(401);
  });
});

describe("Micropub POST", () => {
  test("form-encoded note creates a file and returns 201 with Location", async () => {
    const res = await app.request("/micropub", {
      method: "POST",
      headers: authHeaders({ "content-type": "application/x-www-form-urlencoded" }),
      body: new URLSearchParams({ h: "entry", content: "Hello from a test note" }).toString(),
    });
    expect(res.status).toBe(201);
    const loc = res.headers.get("location");
    expect(loc).toMatch(/^http:\/\/127\.0\.0\.1:3000\/\d{4}\/\d{2}\/\d{2}\//);

    const rows = getDb().query("SELECT * FROM posts").all() as any[];
    expect(rows.length).toBe(1);
    expect(rows[0].post_type).toBe("post");
    const file = await Bun.file((await import("../src/services/content.ts")).CONTENT_DIR + "/" + rows[0].file_path).text();
    expect(file).toContain("Hello from a test note");
  });

  test("JSON article gets a title and article type", async () => {
    const res = await app.request("/micropub", {
      method: "POST",
      headers: authHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({
        type: ["h-entry"],
        properties: { name: ["My Article"], content: ["Long form content."] },
      }),
    });
    expect(res.status).toBe(201);
    const row = getDb().query("SELECT * FROM posts").get() as any;
    expect(row.post_type).toBe("article");
    expect(row.title).toBe("My Article");
  });

  test("mp-syndicate-to creates a pending syndication record", async () => {
    const res = await app.request("/micropub", {
      method: "POST",
      headers: authHeaders({ "content-type": "application/x-www-form-urlencoded" }),
      body: new URLSearchParams({ h: "entry", content: "syndicate me", "mp-syndicate-to": "bluesky" }).toString(),
    });
    expect(res.status).toBe(201);
    const syn = getDb().query("SELECT * FROM syndications").get() as any;
    expect(syn.platform).toBe("bluesky");
    expect(syn.status).toBe("pending");
  });

  test("action=update modifies an existing post", async () => {
    const create = await app.request("/micropub", {
      method: "POST",
      headers: authHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({ type: ["h-entry"], properties: { content: ["original"] } }),
    });
    const url = create.headers.get("location")!;

    const update = await app.request("/micropub", {
      method: "POST",
      headers: authHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({ action: "update", url, replace: { content: ["updated content"] } }),
    });
    expect(update.status).toBe(200);

    const row = getDb().query("SELECT * FROM posts").get() as any;
    const content = await import("../src/services/content.ts");
    const file = await Bun.file(content.CONTENT_DIR + "/" + row.file_path).text();
    expect(file).toContain("updated content");
    expect(file).not.toContain("original");
  });

  test("POST without auth returns 401", async () => {
    const res = await app.request("/micropub", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "content=nope",
    });
    expect(res.status).toBe(401);
  });
});
