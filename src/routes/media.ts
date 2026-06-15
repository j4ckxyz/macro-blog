import { Hono } from "hono";
import { resolve, extname, join } from "node:path";
import { mkdir } from "node:fs/promises";
import { getDb } from "../db/index.ts";
import { getConfig } from "../lib/config.ts";
import { requireAuth } from "../lib/middleware.ts";
import { randomHex } from "../lib/slugify.ts";

export const UPLOADS_DIR = resolve(process.env.MACROBLOG_UPLOADS || "uploads");

const ALLOWED: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "audio/mpeg": ".mp3",
  "audio/mp4": ".m4a",
  "audio/x-m4a": ".m4a",
  "video/mp4": ".mp4",
  "video/webm": ".webm",
  "video/ogg": ".ogv",
  "video/quicktime": ".mov",
};

export interface StoredMedia {
  filename: string;
  url: string;
  mime: string;
  size: number;
  originalName: string;
}

/** Persist an uploaded file to disk and record it in the media table. */
export async function storeUpload(file: File): Promise<StoredMedia> {
  const cfg = getConfig();
  if (file.size > cfg.media.max_file_size) {
    throw new Error(`file too large (max ${cfg.media.max_file_size} bytes)`);
  }
  const mime = file.type || "application/octet-stream";
  const ext = ALLOWED[mime] ?? (extname(file.name) || ".bin");
  if (!ALLOWED[mime] && !extname(file.name)) {
    throw new Error(`unsupported media type: ${mime}`);
  }

  await mkdir(UPLOADS_DIR, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const filename = `${stamp}-${randomHex(8)}${ext}`;
  const absPath = join(UPLOADS_DIR, filename);
  await Bun.write(absPath, file);

  const url = `/uploads/${filename}`;
  getDb()
    .query("INSERT INTO media (filename, original_name, mime_type, size_bytes, url) VALUES (?, ?, ?, ?, ?)")
    .run(filename, file.name, mime, file.size, url);

  return { filename, url, mime, size: file.size, originalName: file.name };
}

export const media = new Hono();

// Any valid token may upload; clients send either `create` or `media` scope.
media.post("/", requireAuth(), async (c) => {
  const form = await c.req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) {
    return c.json({ error: "invalid_request", error_description: "missing file field" }, 400);
  }
  try {
    const stored = await storeUpload(file);
    const cfg = getConfig();
    const absolute = cfg.site.url.replace(/\/+$/, "") + stored.url;
    c.header("Location", absolute);
    return c.json({ url: absolute }, 201);
  } catch (err) {
    return c.json({ error: "invalid_request", error_description: (err as Error).message }, 400);
  }
});
