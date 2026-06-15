import { Database } from "bun:sqlite";
import { resolve, join } from "node:path";
import { readFileSync, existsSync } from "node:fs";
import { SCHEMA } from "./schema.ts";

export const DB_PATH = resolve(process.env.MACROBLOG_DB || "macroblog.db");

let db: Database | null = null;

export function getDb(): Database {
  if (!db) {
    db = new Database(DB_PATH, { create: true });
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("PRAGMA foreign_keys = ON;");
    migrate(db);
  }
  return db;
}

/** Open an isolated database (used by tests). */
export function openDb(path: string): Database {
  const conn = new Database(path, { create: true });
  conn.exec("PRAGMA journal_mode = WAL;");
  conn.exec("PRAGMA foreign_keys = ON;");
  migrate(conn);
  return conn;
}

/**
 * Allow tests to substitute an in-memory or temp database for the
 * process-wide singleton returned by getDb().
 */
export function setDb(conn: Database): void {
  db = conn;
}

export function migrate(conn: Database): void {
  // Create tables from SCHEMA first (bookmark_folders table will be created if not exists)
  conn.exec(SCHEMA);
  
  // Try altering posts table to add bookmark_folder_id
  try {
    conn.exec("ALTER TABLE posts ADD COLUMN bookmark_folder_id INTEGER REFERENCES bookmark_folders(id) ON DELETE SET NULL;");
  } catch (e) {
    // Column already exists, ignore
  }

  // Try altering posts table to add content and categories_json
  try {
    conn.exec("ALTER TABLE posts ADD COLUMN content TEXT;");
  } catch (e) {}
  try {
    conn.exec("ALTER TABLE posts ADD COLUMN categories_json TEXT;");
  } catch (e) {}

  // Try altering timeline table to add remote_cid, root_uri, root_cid, is_reply
  try {
    conn.exec("ALTER TABLE timeline ADD COLUMN remote_cid TEXT;");
  } catch (e) {}
  try {
    conn.exec("ALTER TABLE timeline ADD COLUMN root_uri TEXT;");
  } catch (e) {}
  try {
    conn.exec("ALTER TABLE timeline ADD COLUMN root_cid TEXT;");
  } catch (e) {}
  try {
    conn.exec("ALTER TABLE timeline ADD COLUMN is_reply INTEGER DEFAULT 0;");
  } catch (e) {}
  try {
    conn.exec("ALTER TABLE timeline ADD COLUMN embed_json TEXT;");
  } catch (e) {}

  // Backfill content and categories_json for existing posts if NULL
  try {
    const nullPosts = conn.query("SELECT id, file_path, post_type FROM posts WHERE content IS NULL").all() as any[];
    if (nullPosts.length > 0) {
      const contentDir = resolve(process.env.MACROBLOG_HUGO_SITE || "hugo-site", "content");
      for (const post of nullPosts) {
        try {
          const absPath = join(contentDir, post.file_path);
          if (existsSync(absPath)) {
            const fileContent = readFileSync(absPath, "utf-8");
            const tomlMatch = fileContent.match(/^\+\+\+\r?\n([\s\S]*?)\r?\n\+\+\+\r?\n?([\s\S]*)$/);
            const yamlMatch = fileContent.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
            const m = tomlMatch ?? yamlMatch;
            if (m) {
              const rawFm = m[1];
              const body = m[2] ?? "";
              let categories: string[] = [];
              const catMatch = rawFm.match(/categories\s*=\s*\[([\s\S]*?)\]/);
              if (catMatch) {
                categories = catMatch[1]
                  .split(",")
                  .map((s) => s.trim().replace(/^["']|["']$/g, ""))
                  .filter(Boolean);
              }
              conn.query("UPDATE posts SET content = ?, categories_json = ? WHERE id = ?").run(
                body.replace(/^\n+/, ""),
                JSON.stringify(categories),
                post.id
              );
            }
          }
        } catch (err) {
          console.error(`[db-migration] Failed to backfill post ${post.id}:`, err);
        }
      }
    }
  } catch (e) {
    console.error("[db-migration] Failed backfill scan:", e);
  }
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}

// CLI entry: `bun run src/db/index.ts --migrate`
if (import.meta.main) {
  if (process.argv.includes("--migrate")) {
    const conn = getDb();
    migrate(conn);
    console.log(`✓ Migrations applied to ${DB_PATH}`);
  }
}
