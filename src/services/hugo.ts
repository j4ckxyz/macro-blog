import { $ } from "bun";
import { resolve, join } from "node:path";
import { mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { getDb } from "../db/index.ts";
import { getConfig } from "../lib/config.ts";
import type { WebmentionRow } from "../db/schema.ts";
import { HUGO_SITE } from "./content.ts";

export const PUBLIC_DIR = resolve(process.env.MACROBLOG_PUBLIC || "public");
const WEBMENTION_DATA_DIR = join(HUGO_SITE, "data", "webmentions");

export interface BuildStatus {
  running: boolean;
  lastRun: string | null;
  lastSuccess: boolean;
  log: string;
  durationMs: number;
}

const status: BuildStatus = {
  running: false,
  lastRun: null,
  lastSuccess: false,
  log: "",
  durationMs: 0,
};

export function getBuildStatus(): BuildStatus {
  return { ...status };
}

let phase2Timer: ReturnType<typeof setTimeout> | null = null;
let buildChain: Promise<void> = Promise.resolve();

/**
 * Run a full Hugo build into the public directory, write webmention data,
 * and run Pagefind. Builds are serialised via a promise chain so concurrent
 * callers never run Hugo twice at once.
 */
export function fullBuild(): Promise<void> {
  buildChain = buildChain.then(() => doFullBuild()).catch((err) => {
    console.error("[hugo] build error", err);
  });
  return buildChain;
}

async function doFullBuild(): Promise<void> {
  const cfg = getConfig();
  const start = Date.now();
  status.running = true;
  try {
    await mkdir(PUBLIC_DIR, { recursive: true });
    await writeWebmentionData();

    const themeSeconds = String(Math.floor(Date.now() / 1000));
    const bin = cfg.hugo.binary || "hugo";
    const args = [
      "-s", HUGO_SITE,
      "-d", PUBLIC_DIR,
      "-b", cfg.site.url,
      "--cleanDestinationDir",
      "--logLevel", "warn",
    ];
    if (cfg.hugo.theme) {
      args.push("--theme", cfg.hugo.theme);
    }
    const proc = Bun.spawn([bin, ...args], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        // Override config.toml defaults with live values from the YAML config.
        HUGO_TITLE: cfg.site.title,
        HUGO_LANGUAGECODE: cfg.site.language,
        HUGO_PARAMS_THEME_SECONDS: themeSeconds,
        HUGO_PARAMS_DESCRIPTION: cfg.site.description,
        HUGO_PARAMS_AVATAR: cfg.site.avatar,
        HUGO_PARAMS_AUTHOR_NAME: cfg.site.author,
        HUGO_PARAMS_AUTHOR_USERNAME: cfg.site.username,
        HUGO_PARAMS_INCLUDE_REPLY_TYPE: String(cfg.feeds.include_reply_type),
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    status.log = (out + "\n" + err).trim();
    status.lastSuccess = code === 0;
    if (code !== 0) {
      throw new Error(`hugo exited ${code}: ${err}`);
    }

    await runPagefind();
  } finally {
    status.running = false;
    status.lastRun = new Date().toISOString();
    status.durationMs = Date.now() - start;
  }
}

async function runPagefind(): Promise<void> {
  if (process.env.MACROBLOG_NO_BUILD === "1" || process.env.MACROBLOG_SKIP_PAGEFIND === "1") return;
  try {
    await $`npx -y pagefind --site ${PUBLIC_DIR} --output-path ${join(PUBLIC_DIR, "pagefind")}`.quiet();
  } catch (err) {
    // Pagefind is best-effort (requires network on first run / npx).
    console.warn("[hugo] pagefind skipped:", (err as Error).message);
  }
}

/**
 * Phase 1 (fast): trigger an immediate build and ping Micro.blog, then
 * schedule a debounced full Phase 2 build.
 */
export function triggerBuild(): void {
  if (process.env.MACROBLOG_NO_BUILD === "1") return;
  // Kick a build immediately, debounced so bursts coalesce.
  scheduleFullBuild();
  pingMicroblog().catch(() => {});
}

/** Debounce full builds by 5s to coalesce bursts of posts. */
export function scheduleFullBuild(delayMs = 5000): void {
  if (process.env.MACROBLOG_NO_BUILD === "1") return;
  if (phase2Timer) clearTimeout(phase2Timer);
  phase2Timer = setTimeout(() => {
    phase2Timer = null;
    fullBuild();
  }, delayMs);
}

export async function pingMicroblog(): Promise<void> {
  const cfg = getConfig();
  if (!cfg.microblog.ping_enabled) return;
  const feedUrl = cfg.site.url.replace(/\/+$/, "") + "/feed.json";
  try {
    await fetch(cfg.microblog.ping_url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ url: feedUrl }).toString(),
    });
  } catch (err) {
    console.warn("[hugo] micro.blog ping failed:", (err as Error).message);
  }
}

/**
 * Write approved webmentions grouped by post slug into
 * hugo-site/data/webmentions/<slug>.json so themes can render them.
 */
export async function writeWebmentionData(): Promise<void> {
  const db = getDb();
  await mkdir(WEBMENTION_DATA_DIR, { recursive: true });
  const rows = db
    .query("SELECT * FROM webmentions WHERE status = 'approved' ORDER BY created_at ASC")
    .all() as WebmentionRow[];

  const bySlug = new Map<string, any[]>();
  for (const wm of rows) {
    const slug = wm.post_slug || "_site";
    if (!bySlug.has(slug)) bySlug.set(slug, []);
    bySlug.get(slug)!.push({
      source: wm.source,
      target: wm.target,
      type: wm.type,
      author: { name: wm.author_name, url: wm.author_url, photo: wm.author_avatar },
      content: wm.content,
      published: wm.published,
    });
  }
  for (const [slug, mentions] of bySlug) {
    await Bun.write(join(WEBMENTION_DATA_DIR, `${slug}.json`), JSON.stringify(mentions, null, 2));
  }
}

export function hugoAvailable(): boolean {
  return existsSync(HUGO_SITE);
}
