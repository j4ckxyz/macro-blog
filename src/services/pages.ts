import type { Database } from "bun:sqlite";
import { join } from "node:path";
import { mkdir, rm } from "node:fs/promises";
import { getDb } from "../db/index.ts";
import { getConfig, baseUrl } from "../lib/config.ts";
import type { PostRow } from "../db/schema.ts";
import { CONTENT_DIR, parseFrontMatter } from "./content.ts";
import { buildSlug } from "../lib/slugify.ts";

const PAGES_DIR = join(CONTENT_DIR, "pages");

function tomlStr(s: string): string {
  return '"' + String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n") + '"';
}

export interface PageInput {
  title: string;
  content: string;
  showInNav?: boolean;
  weight?: number;
  status?: "published" | "draft";
}

function serializePage(slug: string, p: PageInput): string {
  const lines = [
    "+++",
    `title = ${tomlStr(p.title)}`,
    `type = "page"`,
    `url = "/${slug}/"`,
    `show_in_nav = ${p.showInNav ? "true" : "false"}`,
    `weight = ${Number.isFinite(p.weight) ? Number(p.weight) : 0}`,
    `draft = ${p.status === "draft" ? "true" : "false"}`,
    "+++",
  ];
  return lines.join("\n") + "\n\n" + (p.content ?? "") + "\n";
}

export function pagePermalink(slug: string): string {
  return `${baseUrl()}${slug}/`;
}

export async function createPage(input: PageInput, db: Database = getDb()): Promise<PostRow> {
  const slug = buildSlug(
    { title: input.title },
    (s) => !!db.query("SELECT 1 FROM posts WHERE slug = ?").get(s),
  );
  const relPath = join("pages", `${slug}.md`);
  await mkdir(PAGES_DIR, { recursive: true });
  await Bun.write(join(CONTENT_DIR, relPath), serializePage(slug, input));
  db.query(
    `INSERT INTO posts (slug, file_path, post_type, title, status, published_at)
     VALUES (?, ?, 'page', ?, ?, CURRENT_TIMESTAMP)`,
  ).run(slug, relPath, input.title, input.status === "draft" ? "draft" : "published");
  return db.query("SELECT * FROM posts WHERE slug = ?").get(slug) as PostRow;
}

export function listPages(db: Database = getDb()): PostRow[] {
  return db
    .query("SELECT * FROM posts WHERE post_type = 'page' AND status != 'deleted' ORDER BY title ASC")
    .all() as PostRow[];
}

export function getPageRow(slug: string, db: Database = getDb()): PostRow | null {
  return db
    .query("SELECT * FROM posts WHERE slug = ? AND post_type = 'page'")
    .get(slug) as PostRow | null;
}

export async function readPage(row: PostRow): Promise<{ title: string; content: string; showInNav: boolean; weight: number; status: string }> {
  const raw = await Bun.file(join(CONTENT_DIR, row.file_path)).text();
  const { frontMatter, body } = parseFrontMatter(raw);
  return {
    title: frontMatter.title ?? row.title ?? "",
    content: body.replace(/^\n+/, "").trimEnd(),
    showInNav: frontMatter.show_in_nav === true || frontMatter.show_in_nav === "true",
    weight: Number(frontMatter.weight) || 0,
    status: row.status,
  };
}

export async function updatePage(row: PostRow, input: PageInput, db: Database = getDb()): Promise<PostRow> {
  await Bun.write(join(CONTENT_DIR, row.file_path), serializePage(row.slug, input));
  db.query("UPDATE posts SET title = ?, status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(
    input.title,
    input.status === "draft" ? "draft" : "published",
    row.id,
  );
  return db.query("SELECT * FROM posts WHERE id = ?").get(row.id) as PostRow;
}

export async function deletePage(row: PostRow, db: Database = getDb()): Promise<void> {
  await rm(join(CONTENT_DIR, row.file_path), { force: true });
  db.query("DELETE FROM posts WHERE id = ?").run(row.id);
}
