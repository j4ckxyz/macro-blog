import { parse, stringify } from "js-yaml";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

export interface SiteConfig {
  url: string;
  title: string;
  author: string;
  username: string;
  description: string;
  avatar: string;
  language: string;
  timezone: string;
}

export interface ServerConfig {
  port: number;
  host: string;
}

export interface HugoConfig {
  binary: string;
  theme: string;
  version: string;
}

export interface AuthConfig {
  password_hash: string;
  session_secret: string;
}

export interface BlueskyConfig {
  enabled: boolean;
  handle: string;
  pds_url: string;
}

export interface MastodonConfig {
  enabled: boolean;
  instance_url: string;
}

export interface CrosspostingConfig {
  bluesky: BlueskyConfig;
  mastodon: MastodonConfig;
}

export interface WebmentionsConfig {
  send: boolean;
  receive: boolean;
  moderation: boolean;
}

export interface FeedsConfig {
  posts_per_page: number;
  include_reply_type: boolean;
}

export interface MediaConfig {
  max_file_size: number;
}

export interface MicroblogConfig {
  ping_enabled: boolean;
  ping_url: string;
}

export interface MacroblogConfig {
  site: SiteConfig;
  server: ServerConfig;
  hugo: HugoConfig;
  auth: AuthConfig;
  crossposting: CrosspostingConfig;
  webmentions: WebmentionsConfig;
  feeds: FeedsConfig;
  media: MediaConfig;
  microblog: MicroblogConfig;
}

const DEFAULTS: MacroblogConfig = {
  site: {
    url: "http://127.0.0.1:3000",
    title: "Macroblog",
    author: "Author",
    username: "author",
    description: "",
    avatar: "/uploads/avatar.jpg",
    language: "en",
    timezone: "UTC",
  },
  server: { port: 3000, host: "127.0.0.1" },
  hugo: { binary: "hugo", theme: "", version: "0.147.0" },
  auth: { password_hash: "", session_secret: "" },
  crossposting: {
    bluesky: { enabled: false, handle: "", pds_url: "https://bsky.social" },
    mastodon: { enabled: false, instance_url: "" },
  },
  webmentions: { send: true, receive: true, moderation: true },
  feeds: { posts_per_page: 20, include_reply_type: false },
  media: { max_file_size: 52428800 },
  microblog: { ping_enabled: false, ping_url: "https://micro.blog/ping" },
};

function deepMerge<T>(base: T, override: any): T {
  if (override === null || override === undefined) return base;
  if (typeof base !== "object" || Array.isArray(base)) return override as T;
  const out: any = Array.isArray(base) ? [...(base as any)] : { ...base };
  for (const key of Object.keys(override)) {
    const bv = (base as any)[key];
    const ov = override[key];
    if (bv && typeof bv === "object" && !Array.isArray(bv) && ov && typeof ov === "object") {
      out[key] = deepMerge(bv, ov);
    } else if (ov !== undefined) {
      out[key] = ov;
    }
  }
  return out;
}

export const CONFIG_PATH = resolve(
  process.env.MACROBLOG_CONFIG || "macroblog.config.yaml",
);

let cached: MacroblogConfig | null = null;

export function loadConfig(path: string = CONFIG_PATH): MacroblogConfig {
  if (!existsSync(path)) {
    // Fall back to defaults (useful for tests / first run).
    return structuredClone(DEFAULTS);
  }
  const raw = parse(require("node:fs").readFileSync(path, "utf8")) || {};
  return deepMerge(structuredClone(DEFAULTS), raw);
}

export function getConfig(): MacroblogConfig {
  if (!cached) cached = loadConfig();
  return cached;
}

export function reloadConfig(): MacroblogConfig {
  cached = loadConfig();
  return cached;
}

/** Set the in-memory config (used by tests). */
export function setConfig(cfg: MacroblogConfig): void {
  cached = cfg;
}

/**
 * Persist (partial) config changes back to the YAML file, preserving
 * unspecified values. Secrets are never written by the admin API path.
 */
export function saveConfig(
  partial: Partial<MacroblogConfig>,
  path: string = CONFIG_PATH,
): MacroblogConfig {
  const current = existsSync(path)
    ? (parse(require("node:fs").readFileSync(path, "utf8")) || {})
    : {};
  const merged = deepMerge(current, partial);
  require("node:fs").writeFileSync(path, stringify(merged), "utf8");
  cached = deepMerge(structuredClone(DEFAULTS), merged);
  return cached;
}

/** Normalise a base URL to always end with a single trailing slash. */
export function baseUrl(cfg: MacroblogConfig = getConfig()): string {
  return cfg.site.url.replace(/\/+$/, "") + "/";
}
