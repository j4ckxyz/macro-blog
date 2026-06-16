import type { Database } from "bun:sqlite";
import { resolve, join, relative } from "node:path";
import { mkdir } from "node:fs/promises";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { getDb } from "../db/index.ts";
import type { PostRow } from "../db/schema.ts";
import { getConfig, baseUrl } from "../lib/config.ts";
import { buildSlug, datePath } from "../lib/slugify.ts";
import type { MicropubCreate, PostType, Photo } from "../lib/micropub-parser.ts";

export const HUGO_SITE = resolve(process.env.MACROBLOG_HUGO_SITE || "hugo-site");
export const CONTENT_DIR = join(HUGO_SITE, "content");

const TYPE_DIRS: Record<PostType, string> = {
  post: "posts",
  article: "articles",
  photo: "photos",
  reply: "replies",
  bookmark: "bookmarks",
  podcast: "podcasts",
};

/** The standard sections that make up the main feed / archive. */
export const CORE_SECTIONS = ["posts", "articles", "photos", "replies", "bookmarks", "podcasts"];

/**
 * Sanitise a custom section name (e.g. "Tweets" → "tweets"). Returns "" when the
 * name is empty or a reserved/core section, so callers fall back to the type dir.
 */
export function sanitizeSection(name: string | undefined | null): string {
  if (!name) return "";
  const s = String(name).toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  if (!s || CORE_SECTIONS.includes(s) || s === "pages") return "";
  return s;
}

export interface FrontMatter {
  title?: string;
  date: string; // ISO
  type: PostType;
  categories?: string[];
  reply_to_url?: string;
  reply_to_hostname?: string;
  reply_to_username?: string;
  syndication?: string[];
  photos?: Photo[];
  podcast_url?: string;
  podcast_duration?: string;
  podcast_mime_type?: string;
  isbn?: string;
  bookshelf?: string;
  bookmark_url?: string;
  bookmark_title?: string;
  bookmark_folder?: string;
  link_back?: boolean;
  lang?: string;
  draft?: boolean;
  [key: string]: any;
}

function tomlString(s: string): string {
  return '"' + String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n") + '"';
}

function tomlArray(arr: string[]): string {
  return "[" + arr.map((v) => tomlString(v)).join(", ") + "]";
}

/** Serialise front matter to a Hugo TOML block (+++ ... +++). */
export function serializeFrontMatter(fm: FrontMatter): string {
  const lines: string[] = ["+++"];
  lines.push(`title = ${tomlString(fm.title ?? "")}`);
  // Hugo accepts a quoted RFC3339 date string.
  lines.push(`date = ${tomlString(fm.date)}`);
  lines.push(`type = ${tomlString(fm.type)}`);
  if (fm.categories && fm.categories.length) {
    lines.push(`categories = ${tomlArray(fm.categories)}`);
  } else {
    lines.push(`categories = []`);
  }
  if (fm.reply_to_url) lines.push(`reply_to_url = ${tomlString(fm.reply_to_url)}`);
  if (fm.reply_to_hostname) lines.push(`reply_to_hostname = ${tomlString(fm.reply_to_hostname)}`);
  if (fm.reply_to_username) lines.push(`reply_to_username = ${tomlString(fm.reply_to_username)}`);
  if (fm.syndication && fm.syndication.length) {
    lines.push(`syndication = ${tomlArray(fm.syndication)}`);
  }
  if (fm.photos && fm.photos.length) {
    lines.push("photos = [");
    for (const p of fm.photos) {
      const alt = p.alt ?? "";
      let optStr = "";
      if (p.width) optStr += `, width = ${p.width}`;
      if (p.height) optStr += `, height = ${p.height}`;
      lines.push(`  { url = ${tomlString(p.url)}, alt = ${tomlString(alt)}${optStr} },`);
    }
    lines.push("]");
  }
  if (fm.podcast_url) lines.push(`podcast_url = ${tomlString(fm.podcast_url)}`);
  if (fm.podcast_duration) lines.push(`podcast_duration = ${tomlString(fm.podcast_duration)}`);
  if (fm.podcast_mime_type) lines.push(`podcast_mime_type = ${tomlString(fm.podcast_mime_type)}`);
  if (fm.isbn) lines.push(`isbn = ${tomlString(fm.isbn)}`);
  if (fm.bookshelf) lines.push(`bookshelf = ${tomlString(fm.bookshelf)}`);
  if (fm.bookmark_url) lines.push(`bookmark_url = ${tomlString(fm.bookmark_url)}`);
  if (fm.bookmark_title) lines.push(`bookmark_title = ${tomlString(fm.bookmark_title)}`);
  if (fm.bookmark_folder) lines.push(`bookmark_folder = ${tomlString(fm.bookmark_folder)}`);
  if (fm.link_back !== undefined) lines.push(`link_back = ${fm.link_back ? "true" : "false"}`);
  if (fm.lang) lines.push(`lang = ${tomlString(fm.lang)}`);
  lines.push(`draft = ${fm.draft ? "true" : "false"}`);
  lines.push("+++");
  return lines.join("\n");
}

export interface ParsedFile {
  frontMatterRaw: string;
  frontMatter: Record<string, any>;
  body: string;
}

/**
 * Parse a Hugo Markdown file's TOML (or YAML) front matter. This is a
 * pragmatic parser covering the fields Macroblog writes; it round-trips the
 * values written by serializeFrontMatter().
 */
export function parseFrontMatter(content: string): ParsedFile {
  const tomlMatch = content.match(/^\+\+\+\r?\n([\s\S]*?)\r?\n\+\+\+\r?\n?([\s\S]*)$/);
  const yamlMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  const m = tomlMatch ?? yamlMatch;
  if (!m) return { frontMatterRaw: "", frontMatter: {}, body: content };

  const raw = m[1];
  const body = m[2] ?? "";
  const fm: Record<string, any> = {};
  for (const line of raw.split(/\r?\n/)) {
    const kv = line.match(/^([a-zA-Z0-9_]+)\s*[:=]\s*(.+)$/);
    if (!kv) continue;
    const key = kv[1];
    if (key === "photos") continue;
    let val = kv[2].trim();
    if (val.startsWith("[") || val.startsWith("{")) {
      fm[key] = parseInlineArray(val);
    } else if (val === "true" || val === "false") {
      fm[key] = val === "true";
    } else {
      fm[key] = val.replace(/^["']|["']$/g, "");
    }
  }

  // Custom parsing for photos array of inline tables
  const photosMatch = raw.match(/photos\s*=\s*\[([\s\S]*?)\]/);
  if (photosMatch) {
    const photoBlocks: any[] = [];
    const blockRegex = /\{([^}]+)\}/g;
    let bm;
    while ((bm = blockRegex.exec(photosMatch[1])) !== null) {
      const parts = bm[1].split(",");
      const obj: any = {};
      for (const part of parts) {
        const kv = part.split("=");
        if (kv.length === 2) {
          const k = kv[0].trim();
          const v = kv[1].trim().replace(/^["']|["']$/g, "");
          if (k === "width" || k === "height") {
            obj[k] = Number(v) || undefined;
          } else {
            obj[k] = v;
          }
        }
      }
      if (obj.url) {
        photoBlocks.push(obj);
      }
    }
    fm.photos = photoBlocks;
  }

  return { frontMatterRaw: raw, frontMatter: fm, body };
}

function parseInlineArray(val: string): string[] {
  if (!val.startsWith("[")) return [];
  const inner = val.replace(/^\[|\]$/g, "").trim();
  if (!inner) return [];
  return inner.split(",").map((s) => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
}

export interface WrittenPost {
  slug: string;
  filePath: string; // relative to CONTENT_DIR
  absPath: string;
  permalink: string;
  type: PostType;
  frontMatter: FrontMatter;
}

function hostnameOf(url?: string): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}

/** Compute a post's permalink from its date + slug (mirrors Hugo config). */
export function permalinkFor(date: Date, slug: string): string {
  const { year, month, day } = datePath(date);
  return `${baseUrl()}${year}/${month}/${day}/${slug}/`;
}

function buildFrontMatter(req: MicropubCreate, date: Date): FrontMatter {
  const fm: FrontMatter = {
    title: req.name ?? "",
    date: date.toISOString().replace(/\.\d{3}Z$/, "Z"),
    type: req.type,
    categories: req.categories,
    lang: (req as any).lang || getConfig().site.language || "en",
    draft: req.status === "draft",
  };
  if (req.inReplyTo) {
    fm.reply_to_url = req.inReplyTo;
    fm.reply_to_hostname = hostnameOf(req.inReplyTo);
  }
  if (req.photos.length) fm.photos = req.photos;
  if (req.bookmarkOf) {
    fm.bookmark_url = req.bookmarkOf;
    fm.bookmark_title = firstFromProps(req.properties, "bookmark-title");
    if ((req as any).bookmark_folder) {
      fm.bookmark_folder = (req as any).bookmark_folder;
    }
  }
  if ((req as any).link_back !== undefined) {
    fm.link_back = (req as any).link_back === true;
  }
  const isbn = firstFromProps(req.properties, "isbn");
  if (isbn) fm.isbn = isbn;
  const podcast = firstFromProps(req.properties, "audio") || firstFromProps(req.properties, "podcast_url");
  if (podcast && req.type === "podcast") fm.podcast_url = podcast;
  return fm;
}

function firstFromProps(props: Record<string, any[]>, key: string): string | undefined {
  const v = props[key];
  if (!v || !v.length) return undefined;
  const first = v[0];
  if (typeof first === "object" && first && "value" in first) return String(first.value);
  return first === undefined ? undefined : String(first);
}

/**
 * Create a new post: pick a slug, write the Markdown file, and insert a row
 * into the posts table.
 */
export async function createPost(
  req: MicropubCreate,
  db: Database = getDb(),
): Promise<WrittenPost> {
  const date = req.published ? new Date(req.published) : new Date();
  const slug = buildSlug(
    { title: req.name, date },
    (s) => !!db.query("SELECT 1 FROM posts WHERE slug = ?").get(s),
  );

  const fm = buildFrontMatter(req, date);

  let folderId: number | null = null;
  if (fm.bookmark_folder) {
    const folderName = String(fm.bookmark_folder).trim();
    if (folderName) {
      let folder = db.query("SELECT id FROM bookmark_folders WHERE name = ?").get(folderName) as { id: number } | null;
      if (!folder) {
        db.query("INSERT INTO bookmark_folders (name) VALUES (?)").run(folderName);
        folder = db.query("SELECT id FROM bookmark_folders WHERE name = ?").get(folderName) as { id: number } | null;
      }
      folderId = folder ? folder.id : null;
    }
  }

  // A custom section (e.g. "tweets") routes content into its own Hugo section,
  // kept out of the main feed/archive; otherwise use the per-type directory.
  const dir = sanitizeSection(req.section) || TYPE_DIRS[req.type];
  const relPath = join(dir, `${slug}.md`);
  const absPath = join(CONTENT_DIR, relPath);
  await mkdir(join(CONTENT_DIR, dir), { recursive: true });

  const fileContent = serializeFrontMatter(fm) + "\n\n" + (req.content ?? "") + "\n";
  await Bun.write(absPath, fileContent);

  const now = new Date();
  const scheduled = date.getTime() > now.getTime() + 1000;
  let status: string;
  if (req.status === "draft") status = "draft";
  else if (scheduled) status = "scheduled";
  else status = "published";

  db.query(
    `INSERT INTO posts (slug, file_path, post_type, title, status, published_at, scheduled_at, bookmark_folder_id, content, categories_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    slug,
    relPath,
    req.type,
    req.name ?? null,
    status,
    status === "published" ? date.toISOString() : null,
    scheduled ? date.toISOString() : null,
    folderId,
    req.content ?? "",
    JSON.stringify(req.categories ?? []),
  );

  return {
    slug,
    filePath: relPath,
    absPath,
    permalink: permalinkFor(date, slug),
    type: req.type,
    frontMatter: fm,
  };
}

export function getPostBySlug(slug: string, db: Database = getDb()): PostRow | null {
  return db.query("SELECT * FROM posts WHERE slug = ?").get(slug) as PostRow | null;
}

export function getPostByPermalink(url: string, db: Database = getDb()): PostRow | null {
  // Extract the trailing slug from a permalink URL.
  const m = url.replace(/\/+$/, "").match(/\/([^/]+)$/);
  if (!m) return null;
  return getPostBySlug(m[1], db);
}

/** Read a post's current file content. */
export async function readPostFile(post: PostRow): Promise<string> {
  return await Bun.file(join(CONTENT_DIR, post.file_path)).text();
}

/** Apply a Micropub update (replace/add/delete properties) to a post file. */
export async function updatePost(
  post: PostRow,
  ops: { replace?: Record<string, any[]>; add?: Record<string, any[]>; delete?: string[] | Record<string, any[]> },
  db: Database = getDb(),
): Promise<WrittenPost> {
  const content = await readPostFile(post);
  const parsed = parseFrontMatter(content);
  let body = parsed.body.replace(/^\n+/, "");
  const fm = parsed.frontMatter;

  const applyContent = (val: any) => {
    body = Array.isArray(val) ? extractText(val[0]) : extractText(val);
  };

  if (ops.replace) {
    for (const [key, val] of Object.entries(ops.replace)) {
      if (key === "content") applyContent(val);
      else if (key === "name") fm.title = Array.isArray(val) ? val[0] : val;
      else if (key === "category") fm.categories = (val as any[]).map(String);
      else if (key === "syndication") fm.syndication = (val as any[]).map(String);
      else if (key === "photos") fm.photos = val;
      else if (key === "bookmark_folder") fm.bookmark_folder = Array.isArray(val) ? val[0] : val;
      else if (key === "link_back") fm.link_back = Array.isArray(val) ? (val[0] === true || val[0] === "true") : (val === true || val === "true");
      else fm[key] = Array.isArray(val) && val.length === 1 ? val[0] : val;
    }
  }
  if (ops.add) {
    for (const [key, val] of Object.entries(ops.add)) {
      if (key === "category") fm.categories = [...(fm.categories ?? []), ...(val as any[]).map(String)];
      else if (key === "syndication") fm.syndication = [...(fm.syndication ?? []), ...(val as any[]).map(String)];
      else fm[key] = val;
    }
  }
  if (ops.delete) {
    if (Array.isArray(ops.delete)) {
      for (const key of ops.delete) {
        if (key === "category") delete fm.categories;
        else delete fm[key];
      }
    }
  }

  const newFm = normaliseFm(fm, post.post_type as PostType);
  const fileContent = serializeFrontMatter(newFm) + "\n\n" + body + "\n";
  await Bun.write(join(CONTENT_DIR, post.file_path), fileContent);

  let folderId: number | null = null;
  if (newFm.bookmark_folder) {
    const folderName = String(newFm.bookmark_folder).trim();
    if (folderName) {
      let folder = db.query("SELECT id FROM bookmark_folders WHERE name = ?").get(folderName) as { id: number } | null;
      if (!folder) {
        db.query("INSERT INTO bookmark_folders (name) VALUES (?)").run(folderName);
        folder = db.query("SELECT id FROM bookmark_folders WHERE name = ?").get(folderName) as { id: number } | null;
      }
      folderId = folder ? folder.id : null;
    }
  }

  db.query(
    "UPDATE posts SET title = ?, bookmark_folder_id = ?, content = ?, categories_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?"
  ).run(
    newFm.title ?? null,
    folderId,
    body,
    JSON.stringify(newFm.categories ?? []),
    post.id,
  );

  return {
    slug: post.slug,
    filePath: post.file_path,
    absPath: join(CONTENT_DIR, post.file_path),
    permalink: permalinkFor(new Date(newFm.date), post.slug),
    type: post.post_type as PostType,
    frontMatter: newFm,
  };
}

function extractText(v: any): string {
  if (v === undefined || v === null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "object" && "html" in v) return String(v.html);
  if (typeof v === "object" && "value" in v) return String(v.value);
  return String(v);
}

function normaliseFm(fm: Record<string, any>, type: PostType): FrontMatter {
  return {
    title: fm.title ?? "",
    date: fm.date ?? new Date().toISOString(),
    type: (fm.type as PostType) ?? type,
    categories: Array.isArray(fm.categories) ? fm.categories : [],
    reply_to_url: fm.reply_to_url,
    reply_to_hostname: fm.reply_to_hostname,
    reply_to_username: fm.reply_to_username,
    syndication: Array.isArray(fm.syndication) ? fm.syndication : undefined,
    photos: Array.isArray(fm.photos) ? fm.photos : undefined,
    podcast_url: fm.podcast_url,
    podcast_duration: fm.podcast_duration,
    podcast_mime_type: fm.podcast_mime_type,
    isbn: fm.isbn,
    bookshelf: fm.bookshelf,
    bookmark_url: fm.bookmark_url,
    bookmark_title: fm.bookmark_title,
    bookmark_folder: fm.bookmark_folder,
    link_back: fm.link_back !== undefined ? (fm.link_back === true || fm.link_back === "true") : undefined,
    lang: fm.lang,
    draft: fm.draft === true || fm.draft === "true",
  };
}

/** Soft-delete a post: set draft=true in front matter and mark deleted in DB. */
export async function deletePost(post: PostRow, db: Database = getDb()): Promise<void> {
  const content = await readPostFile(post);
  const parsed = parseFrontMatter(content);
  const fm = normaliseFm(parsed.frontMatter, post.post_type as PostType);
  fm.draft = true;
  const body = parsed.body.replace(/^\n+/, "");
  await Bun.write(join(CONTENT_DIR, post.file_path), serializeFrontMatter(fm) + "\n\n" + body + "\n");
  db.query("UPDATE posts SET status = 'deleted', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(post.id);
}

/** Add a syndication URL to a post's front matter (u-syndication). */
export async function addSyndicationUrl(post: PostRow, url: string): Promise<void> {
  const content = await readPostFile(post);
  const parsed = parseFrontMatter(content);
  const fm = normaliseFm(parsed.frontMatter, post.post_type as PostType);
  // Dedupe defensively so a re-dispatch never doubles the syndication icons.
  fm.syndication = [...new Set([...(fm.syndication ?? []), url])];
  const body = parsed.body.replace(/^\n+/, "");
  await Bun.write(join(CONTENT_DIR, post.file_path), serializeFrontMatter(fm) + "\n\n" + body + "\n");
}

export function listPosts(
  opts: { status?: string; limit?: number; offset?: number; type?: string; section?: string; folderId?: number; q?: string } = {},
  db: Database = getDb(),
): PostRow[] {
  const limit = opts.limit ?? 50;
  const offset = opts.offset ?? 0;
  
  let queryStr = "SELECT * FROM posts WHERE 1=1";
  const params: any[] = [];
  
  if (opts.status && opts.status !== "all" && opts.status !== "") {
    queryStr += " AND status = ?";
    params.push(opts.status);
  } else {
    // Filter out deleted posts by default
    queryStr += " AND status != 'deleted'";
  }
  
  if (opts.type) {
    queryStr += " AND post_type = ?";
    params.push(opts.type);
  }

  if (opts.section) {
    // file_path is "<section>/<slug>.md", so match by directory prefix.
    queryStr += " AND file_path LIKE ?";
    params.push(`${opts.section}/%`);
  }

  if (opts.folderId) {
    queryStr += " AND bookmark_folder_id = ?";
    params.push(opts.folderId);
  }
  
  if (opts.q) {
    queryStr += " AND (title LIKE ? OR slug LIKE ?)";
    params.push(`%${opts.q}%`, `%${opts.q}%`);
  }
  
  queryStr += " ORDER BY created_at DESC LIMIT ? OFFSET ?";
  params.push(limit, offset);
  
  return db.query(queryStr).all(...params) as PostRow[];
}

/**
 * Distinct non-core content sections present in the DB (e.g. "tweets") with a
 * post count each — used by the admin to filter/manage imported collections.
 */
export function listSections(db: Database = getDb()): { section: string; count: number }[] {
  const rows = db
    .query(
      `SELECT substr(file_path, 1, instr(file_path, '/') - 1) AS section, COUNT(*) AS count
       FROM posts WHERE status != 'deleted' AND instr(file_path, '/') > 0
       GROUP BY section ORDER BY section`,
    )
    .all() as { section: string; count: number }[];
  return rows.filter((r) => r.section && !CORE_SECTIONS.includes(r.section));
}

export { TYPE_DIRS };

/**
 * Ensure every Markdown file on disk has a matching `posts` row so it shows up
 * in the admin and can be edited or deleted. Files can exist without a row —
 * the shipped sample post, a Hugo/Micro.blog export dropped into content/, or
 * drift from older versions — and would otherwise be unmanageable. Scans the
 * core type dirs plus any extra custom sections (e.g. "tweets"). Returns the
 * number of rows added.
 */
export function reconcileContent(db: Database = getDb()): number {
  if (!existsSync(CONTENT_DIR)) return 0;
  let added = 0;
  const now = Date.now();
  // Core type dirs (with their post_type) + any other top-level section dirs.
  const dirs = new Map<string, PostType | null>();
  for (const [type, dir] of Object.entries(TYPE_DIRS)) dirs.set(dir, type as PostType);
  for (const entry of readdirSync(CONTENT_DIR, { withFileTypes: true })) {
    if (entry.isDirectory() && !dirs.has(entry.name) && entry.name !== "pages") dirs.set(entry.name, null);
  }

  for (const [dir, type] of dirs) {
    const abs = join(CONTENT_DIR, dir);
    if (!existsSync(abs)) continue;
    let names: string[];
    try { names = readdirSync(abs); } catch { continue; }
    for (const name of names) {
      if (!name.endsWith(".md") || name === "_index.md") continue;
      const slug = name.slice(0, -3);
      if (db.query("SELECT 1 FROM posts WHERE slug = ?").get(slug)) continue;
      let fm: Record<string, any> = {}, body = "";
      try {
        ({ frontMatter: fm, body } = parseFrontMatter(readFileSync(join(abs, name), "utf8")));
      } catch { /* fall through with defaults */ }
      const postType = (fm.type as PostType) || type || "post";
      const dateObj = new Date(fm.date || new Date().toISOString());
      const valid = !isNaN(dateObj.getTime()) ? dateObj : new Date();
      const draft = fm.draft === true || fm.draft === "true";
      const status = draft ? "draft" : valid.getTime() > now + 1000 ? "scheduled" : "published";
      db.query(
        `INSERT INTO posts (slug, file_path, post_type, title, status, published_at, scheduled_at, content, categories_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        slug, join(dir, name), postType, fm.title || null, status,
        status === "published" ? valid.toISOString() : null,
        status === "scheduled" ? valid.toISOString() : null,
        (body || "").trim(), JSON.stringify(Array.isArray(fm.categories) ? fm.categories : []),
      );
      added++;
    }
  }
  if (added) console.log(`[content] reconciled ${added} on-disk post(s) into the database`);
  return added;
}
