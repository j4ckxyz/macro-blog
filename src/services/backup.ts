import { $ } from "bun";
import { mkdtempSync, cpSync, existsSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { getDb, DB_PATH, closeDb, setDb, openDb } from "../db/index.ts";
import { HUGO_SITE } from "./content.ts";
import { CONFIG_PATH } from "../lib/config.ts";

export const UPLOADS_DIR = resolve(process.env.MACROBLOG_UPLOADS || "uploads");
const BACKUP_DIR = resolve(process.env.MACROBLOG_BACKUPS || "backups");

/**
 * Create a portable, consistent backup archive containing everything needed to
 * fully restore a Macroblog instance:
 *   - macroblog.db   (serialized snapshot — consistent even with WAL)
 *   - content/       (all posts as Markdown — the real source of truth)
 *   - uploads/       (media)
 *   - macroblog.config.yaml
 *
 * Returns the path to the created .tar.gz.
 */
export async function createBackup(): Promise<string> {
  mkdirSync(BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const outFile = join(BACKUP_DIR, `macroblog-backup-${stamp}.tar.gz`);
  const staging = mkdtempSync(join(tmpdir(), "mb-backup-"));

  try {
    // Consistent DB snapshot via serialize() (handles WAL transparently).
    const dbBytes = getDb().serialize();
    await Bun.write(join(staging, "macroblog.db"), dbBytes);

    const content = join(HUGO_SITE, "content");
    if (existsSync(content)) cpSync(content, join(staging, "content"), { recursive: true });
    if (existsSync(UPLOADS_DIR)) cpSync(UPLOADS_DIR, join(staging, "uploads"), { recursive: true });
    if (existsSync(join(HUGO_SITE, "data"))) cpSync(join(HUGO_SITE, "data"), join(staging, "data"), { recursive: true });
    if (existsSync(CONFIG_PATH)) cpSync(CONFIG_PATH, join(staging, "macroblog.config.yaml"));

    await $`tar czf ${outFile} -C ${staging} .`.quiet();
    return outFile;
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

/**
 * Restore from a backup archive. This OVERWRITES current data, so the caller
 * is expected to confirm. The database connection is re-opened afterwards.
 */
export async function restoreBackup(archive: string): Promise<void> {
  if (!existsSync(archive)) throw new Error(`backup not found: ${archive}`);
  const staging = mkdtempSync(join(tmpdir(), "mb-restore-"));
  try {
    await $`tar xzf ${archive} -C ${staging}`.quiet();

    // Restore database.
    const dbFile = join(staging, "macroblog.db");
    if (existsSync(dbFile)) {
      closeDb();
      mkdirSync(dirname(DB_PATH), { recursive: true });
      cpSync(dbFile, DB_PATH);
      // Drop stale WAL/SHM side files.
      for (const ext of ["-wal", "-shm"]) rmSync(DB_PATH + ext, { force: true });
      setDb(openDb(DB_PATH));
    }

    const content = join(staging, "content");
    if (existsSync(content)) {
      rmSync(join(HUGO_SITE, "content"), { recursive: true, force: true });
      cpSync(content, join(HUGO_SITE, "content"), { recursive: true });
    }
    const uploads = join(staging, "uploads");
    if (existsSync(uploads)) cpSync(uploads, UPLOADS_DIR, { recursive: true });
    const data = join(staging, "data");
    if (existsSync(data)) cpSync(data, join(HUGO_SITE, "data"), { recursive: true });
    const cfg = join(staging, "macroblog.config.yaml");
    if (existsSync(cfg)) cpSync(cfg, CONFIG_PATH);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}
