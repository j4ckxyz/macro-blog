/**
 * SQLite schema for Macroblog. Each statement is idempotent
 * (`CREATE TABLE IF NOT EXISTS`) so migrations can run on every boot.
 */
export const SCHEMA = `
-- Post metadata (source of truth for scheduling/syndication state)
CREATE TABLE IF NOT EXISTS posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT UNIQUE NOT NULL,
  file_path TEXT NOT NULL,
  post_type TEXT NOT NULL,
  title TEXT,
  status TEXT NOT NULL DEFAULT 'draft',
  published_at DATETIME,
  scheduled_at DATETIME,
  bookmark_folder_id INTEGER REFERENCES bookmark_folders(id) ON DELETE SET NULL,
  content TEXT,
  categories_json TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Syndication records (one row per platform per post)
CREATE TABLE IF NOT EXISTS syndications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id INTEGER REFERENCES posts(id),
  platform TEXT NOT NULL,
  remote_id TEXT,
  remote_url TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  error TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- OAuth tokens (one row per platform)
CREATE TABLE IF NOT EXISTS oauth_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  platform TEXT UNIQUE NOT NULL,
  access_token TEXT,
  refresh_token TEXT,
  token_type TEXT,
  expires_at DATETIME,
  scope TEXT,
  extra_json TEXT,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Mastodon app registrations (one per instance)
CREATE TABLE IF NOT EXISTS mastodon_apps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  instance_url TEXT UNIQUE NOT NULL,
  client_id TEXT NOT NULL,
  client_secret TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- IndieAuth authorization codes / sessions
CREATE TABLE IF NOT EXISTS indieauth_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT UNIQUE NOT NULL,
  code_challenge TEXT,
  code_challenge_method TEXT,
  client_id TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  scope TEXT,
  used INTEGER DEFAULT 0,
  expires_at DATETIME NOT NULL
);

-- IndieAuth bearer tokens
CREATE TABLE IF NOT EXISTS indieauth_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token TEXT UNIQUE NOT NULL,
  client_id TEXT NOT NULL,
  scope TEXT,
  me TEXT NOT NULL,
  revoked INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Incoming webmentions
CREATE TABLE IF NOT EXISTS webmentions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,
  target TEXT NOT NULL,
  post_slug TEXT,
  type TEXT,
  author_name TEXT,
  author_url TEXT,
  author_avatar TEXT,
  content TEXT,
  published TEXT,
  status TEXT DEFAULT 'pending',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(source, target)
);

-- Outgoing webmention queue
CREATE TABLE IF NOT EXISTS webmention_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,
  target TEXT NOT NULL,
  status TEXT DEFAULT 'pending',
  attempts INTEGER DEFAULT 0,
  last_attempt DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(source, target)
);

-- Replies fetched from cross-posting platforms (Bluesky / Mastodon), unified
-- with webmentions in the admin "Mentions" tab so they can be answered in one place.
CREATE TABLE IF NOT EXISTS social_replies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  platform TEXT NOT NULL,              -- bluesky, mastodon
  post_slug TEXT,
  remote_id TEXT NOT NULL,             -- status id (mastodon) or at:// uri (bluesky)
  remote_cid TEXT,                     -- bluesky cid (needed to reply)
  root_id TEXT,                        -- bluesky thread root uri
  root_cid TEXT,
  author TEXT,
  author_url TEXT,
  avatar TEXT,
  content TEXT,
  url TEXT,
  published TEXT,
  replied INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(platform, remote_id)
);

-- Cached "following" timeline pulled from Bluesky + Mastodon (server-side) so
-- the Timeline tab loads instantly when the webapp opens.
CREATE TABLE IF NOT EXISTS timeline (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  platform TEXT NOT NULL,              -- bluesky, mastodon
  remote_id TEXT NOT NULL,            -- at:// uri or status id
  remote_cid TEXT,
  root_uri TEXT,
  root_cid TEXT,
  author_name TEXT,
  author_handle TEXT,
  author_avatar TEXT,
  author_url TEXT,
  content TEXT,
  url TEXT,
  media_json TEXT,                     -- JSON array of {url, alt}
  reposted_by TEXT,
  created_at TEXT,                     -- post timestamp (ISO)
  is_reply INTEGER DEFAULT 0,
  embed_json TEXT,                     -- JSON embed or quote record
  fetched_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(platform, remote_id)
);

-- Bookmark folders
CREATE TABLE IF NOT EXISTS bookmark_folders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Uploaded media
CREATE TABLE IF NOT EXISTS media (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  filename TEXT NOT NULL,
  original_name TEXT,
  mime_type TEXT,
  size_bytes INTEGER,
  url TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_posts_status ON posts(status);
CREATE INDEX IF NOT EXISTS idx_posts_slug ON posts(slug);
CREATE INDEX IF NOT EXISTS idx_syndications_post ON syndications(post_id);
CREATE INDEX IF NOT EXISTS idx_webmentions_slug ON webmentions(post_slug);
CREATE INDEX IF NOT EXISTS idx_webmentions_status ON webmentions(status);
`;

export interface PostRow {
  id: number;
  slug: string;
  file_path: string;
  post_type: string;
  title: string | null;
  status: string;
  published_at: string | null;
  scheduled_at: string | null;
  bookmark_folder_id: number | null;
  created_at: string;
  updated_at: string;
}

export interface SyndicationRow {
  id: number;
  post_id: number;
  platform: string;
  remote_id: string | null;
  remote_url: string | null;
  status: string;
  error: string | null;
  created_at: string;
}

export interface OAuthTokenRow {
  id: number;
  platform: string;
  access_token: string | null;
  refresh_token: string | null;
  token_type: string | null;
  expires_at: string | null;
  scope: string | null;
  extra_json: string | null;
  updated_at: string;
}

export interface MastodonAppRow {
  id: number;
  instance_url: string;
  client_id: string;
  client_secret: string;
  created_at: string;
}

export interface IndieauthSessionRow {
  id: number;
  code: string;
  code_challenge: string | null;
  code_challenge_method: string | null;
  client_id: string;
  redirect_uri: string;
  scope: string | null;
  used: number;
  expires_at: string;
}

export interface IndieauthTokenRow {
  id: number;
  token: string;
  client_id: string;
  scope: string | null;
  me: string;
  revoked: number;
  created_at: string;
}

export interface WebmentionRow {
  id: number;
  source: string;
  target: string;
  post_slug: string | null;
  type: string | null;
  author_name: string | null;
  author_url: string | null;
  author_avatar: string | null;
  content: string | null;
  published: string | null;
  status: string;
  created_at: string;
}

export interface WebmentionQueueRow {
  id: number;
  source: string;
  target: string;
  status: string;
  attempts: number;
  last_attempt: string | null;
  created_at: string;
}

export interface SocialReplyRow {
  id: number;
  platform: string;
  post_slug: string | null;
  remote_id: string;
  remote_cid: string | null;
  root_id: string | null;
  root_cid: string | null;
  author: string | null;
  author_url: string | null;
  avatar: string | null;
  content: string | null;
  url: string | null;
  published: string | null;
  replied: number;
  created_at: string;
}

export interface TimelineRow {
  id: number;
  platform: string;
  remote_id: string;
  remote_cid: string | null;
  root_uri: string | null;
  root_cid: string | null;
  author_name: string | null;
  author_handle: string | null;
  author_avatar: string | null;
  author_url: string | null;
  content: string | null;
  url: string | null;
  media_json: string | null;
  reposted_by: string | null;
  created_at: string | null;
  is_reply: number | null;
  embed_json: string | null;
  fetched_at: string;
}

export interface MediaRow {
  id: number;
  filename: string;
  original_name: string | null;
  mime_type: string | null;
  size_bytes: number | null;
  url: string;
  created_at: string;
}
