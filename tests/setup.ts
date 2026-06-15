/**
 * Test preload: builds an isolated sandbox so tests never touch the real
 * database, content, or public output. Runs before any src module is imported,
 * so the env vars are in place when modules resolve their paths.
 */
import { mkdirSync, rmSync, cpSync, existsSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const SANDBOX = join(ROOT, ".test-sandbox");

// Fresh sandbox each run.
rmSync(SANDBOX, { recursive: true, force: true });
mkdirSync(SANDBOX, { recursive: true });

const hugoSite = join(SANDBOX, "hugo-site");
const pub = join(SANDBOX, "public");
const uploads = join(SANDBOX, "uploads");
const db = join(SANDBOX, "test.db");
const configPath = join(SANDBOX, "macroblog.config.yaml");

// Copy real Hugo layouts/config/static so Hugo builds work in the sandbox.
mkdirSync(hugoSite, { recursive: true });
cpSync(join(ROOT, "hugo-site", "config.toml"), join(hugoSite, "config.toml"));
cpSync(join(ROOT, "hugo-site", "layouts"), join(hugoSite, "layouts"), { recursive: true });
if (existsSync(join(ROOT, "hugo-site", "static"))) {
  cpSync(join(ROOT, "hugo-site", "static"), join(hugoSite, "static"), { recursive: true, dereference: true });
}
for (const d of ["posts", "articles", "photos", "replies", "bookmarks", "podcasts"]) {
  mkdirSync(join(hugoSite, "content", d), { recursive: true });
}
mkdirSync(join(hugoSite, "data", "webmentions"), { recursive: true });
mkdirSync(uploads, { recursive: true });

// Known password hash for "test-password".
const passwordHash = await Bun.password.hash("test-password");
writeFileSync(
  configPath,
  `site:
  url: "http://127.0.0.1:3000"
  title: "Test Blog"
  author: "Tester"
  username: "tester"
  description: "A test blog"
  avatar: "/uploads/avatar.jpg"
  language: "en"
  timezone: "UTC"
server:
  port: 3000
  host: "127.0.0.1"
hugo:
  binary: "hugo"
  theme: ""
auth:
  password_hash: "${passwordHash}"
  session_secret: "test-secret"
crossposting:
  bluesky:
    enabled: true
    handle: "tester.bsky.social"
    pds_url: "https://bsky.social"
  mastodon:
    enabled: true
    instance_url: "https://mastodon.example"
webmentions:
  send: true
  receive: true
  moderation: true
feeds:
  posts_per_page: 20
  include_reply_type: false
media:
  max_file_size: 52428800
microblog:
  ping_enabled: false
  ping_url: "https://micro.blog/ping"
`,
);

process.env.MACROBLOG_HUGO_SITE = hugoSite;
process.env.MACROBLOG_PUBLIC = pub;
process.env.MACROBLOG_UPLOADS = uploads;
process.env.MACROBLOG_DB = db;
process.env.MACROBLOG_CONFIG = configPath;
process.env.MACROBLOG_NO_BUILD = "1";
process.env.MACROBLOG_NO_DISPATCH = "1";
process.env.MACROBLOG_QUIET = "1";
process.env.TEST_PASSWORD = "test-password";

export {};
