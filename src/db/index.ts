import { Database } from "bun:sqlite";
import { resolve } from "node:path";
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
  conn.exec(SCHEMA);
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
