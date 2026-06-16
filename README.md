# Macroblog

A self-hosted, **single-user** microblogging platform that is fully
**Micro.blog-compatible**. Macroblog uses [Hugo](https://gohugo.io) for static
site generation (the same engine Micro.blog uses) and a fast
[Bun](https://bun.sh) + [Hono](https://hono.dev) backend for all the dynamic
parts: Micropub, IndieAuth, Webmentions, JSON Feed, and cross-posting to
**Bluesky** and **Mastodon/GoToSocial**.

It runs comfortably on a Raspberry Pi 4 (under ~200 MB RAM at idle) and has no
native ActivityPub — Fediverse reach comes entirely from Mastodon cross-posting.

## Highlights

- **Micropub** server — post from the Micro.blog apps, iA Writer, MarsEdit, Quill, etc.
- **IndieAuth** — sign in to clients with your own domain (PKCE, bearer tokens), with
  modern metadata discovery and CORS so browser-based and mobile writing clients just work.
- **JSON Feed 1.1 + RSS + microformats2** — importable into / followable from Micro.blog.
- **Cross-posting** to Bluesky (ATProto OAuth, DPoP, **least-privilege scopes**) and Mastodon/GoToSocial.
- **Following timeline** — your Bluesky + Mastodon home feeds, merged and cached server-side so they load instantly.
- **Unified Mentions** — read and reply to Bluesky + Mastodon replies in one place (your own self-replies are never shown).
- **Mobile-first** — responsive public site and admin (composer, browsing, native-style bottom tab bar) so you can write and publish from your phone.
- **Customisable look** — pick a built-in font **or paste a Google Fonts URL** for the heading and body separately, set accent/background/text colours, and upload a profile photo from Settings → Appearance (no theme editing).
- **Webmentions** *(deprecated)* — still supported but off by default.
- **Custom pages** — create standalone pages (e.g. `/about/`) and toggle them into the site nav, all from the admin.
- **Theme-compatible** — drop a Micro.blog Hugo theme into `hugo-site/themes/` and it just works.
- **Web admin** — compose, manage posts/media/mentions, connect accounts, change settings, back up — all from the browser.
- **Painless backups & updates** — your content/db/uploads/config are never overwritten by an update.

---

## Quick start

### Docker (recommended — works on macOS, Linux, Windows, any ARM/x86)

Configure **one file** and build locally:

```bash
git clone https://github.com/j4ckxyz/macro-blog
cd macro-blog
cp .env.example .env        # ← the only file you edit
$EDITOR .env                # set URL, identity, and an admin password
docker compose up -d --build
```

That's it. Open **`http://127.0.0.1:3000/admin/`** and sign in with the password
from `.env`. The container bundles Bun + Hugo, builds your site on boot, and
persists everything in named volumes:

| Volume | Holds |
|---|---|
| `mb_data` | config, database, backups |
| `mb_content` | your posts (Markdown) |
| `mb_uploads` | media |
| `mb_hugodata` | cached webmentions / replies |

Everything in `.env` is applied on **first boot** (config + session secret +
admin password are generated automatically). After that, manage the blog from
the web admin. Useful commands:

```bash
docker compose logs -f                                  # follow logs
docker compose exec macroblog bun run macroblog --backup # write a backup into mb_data
docker compose pull && docker compose up -d --build      # update (data is preserved)
docker compose down                                      # stop (volumes kept)
```

To expose it publicly, keep the container bound to localhost and put a
Cloudflare Tunnel or reverse proxy in front (see "Making it reachable" below),
then set `MACROBLOG_SITE_URL` to your https domain and rebuild
(Settings → Rebuild site). On a VPS you may instead map `"3000:3000"` in
`docker-compose.yml` and terminate TLS at your proxy.

### One-liner (fresh machine, no Docker)

```bash
curl -fsSL https://raw.githubusercontent.com/j4ckxyz/macro-blog/main/install.sh | bash
```

This installs Bun + Hugo if needed, fetches Macroblog into `~/macroblog`,
generates a session secret, prompts for your admin password, builds the site,
and prints how to reach it. Then:

```bash
cd ~/macroblog
bun run start
# Admin UI → http://127.0.0.1:3000/admin/
# Your blog → http://127.0.0.1:3000/
```

### Manual (Raspberry Pi / Ubuntu)

```bash
git clone https://github.com/j4ckxyz/macro-blog ~/macroblog
cd ~/macroblog
./setup.sh
bun run macroblog --set-password
bun run start
```

### Run as a service (starts on boot)

```bash
sudo ./setup-service.sh
journalctl -u macroblog -f
```

---

## Using the web admin

Everything is managed from the browser — no config-file editing required for
day-to-day use.

1. Open **`http://127.0.0.1:3000/admin/`** (or your domain + `/admin/`).
2. Sign in with the password you set via `--set-password`.
3. You land on the **composer** (Micro.blog-style):
   - Type a note and hit **Post**. It's a live Markdown editor — **bold**,
     _italic_, `code`, links, headings and #hashtags are styled inline as you
     type. `#hashtags` cross-post to Bluesky as real, clickable tag facets;
     bold/italic are stripped when cross-posting (Bluesky/Mastodon are plain
     text). Keyboard shortcuts: **⌘/Ctrl-B** bold, **⌘/Ctrl-I** italic, and
     **⌘/Ctrl-K** to wrap the selected text in a link.
   - The **⋯** menu holds post type (Note / Article / Photo / Bookmark), tags,
     scheduling, "save as draft", and cross-post toggles.
   - The toolbar adds images (upload), audio, bold, italic and links.
4. The sidebar gives you **Timeline** (your merged Bluesky + Mastodon following
   feed, refreshed every 5 min and cached so it's instant), **Posts**,
   **Mentions** (webmentions + Bluesky/Mastodon replies you can answer inline),
   **Uploads**, and **Settings**.
   On phones this becomes a bottom tab bar — everything is touch-friendly.
5. **Pages** lets you create standalone pages (e.g. an About page) in Markdown
   and toggle "Show in nav" to add them to your site header.
6. **Settings** is where you set **Appearance** (profile photo, font, colours),
   connect Bluesky/Mastodon, choose a theme, change your password, toggle
   webmentions/feeds, **download a backup**, and rebuild.

> First-run checklist: set `site.url` to your real domain, set a password,
> connect any cross-posting accounts, then **Settings → Rebuild site**.

---

## Making it reachable from the internet

Macroblog binds to `127.0.0.1` by default and refuses to serve the admin API
without a password — keep it that way and put a tunnel or reverse proxy in front.

### Cloudflare Tunnel (recommended — no open ports, free TLS)

```bash
cloudflared tunnel --url http://127.0.0.1:3000
```

Point your domain at the tunnel, then set `site.url` in
`macroblog.config.yaml` to your `https://` domain and rebuild
(Settings → Rebuild site).

### VPS with Caddy (automatic HTTPS)

```caddy
yoursite.com {
    reverse_proxy 127.0.0.1:3000
}
```

### Raw IP on a VPS

Set `server.host: "0.0.0.0"` only if you also put TLS in front. Plain HTTP over
a public IP is not recommended (tokens travel in the clear).

---

## Configuration reference

All configuration lives in `macroblog.config.yaml` (see
`macroblog.config.yaml.example`). Most of it is editable from **Settings** in the
web admin. Secrets (`auth.password_hash`, `auth.session_secret`) are never
exposed or writable through the web API.

| Section | Key | Meaning |
|---|---|---|
| `site` | `url` | Public base URL (HTTPS in prod, `http://127.0.0.1:3000` for dev). |
| | `title`, `author`, `username`, `description`, `avatar` | Identity used in feeds, themes, rel-me, WebFinger. |
| `server` | `host`, `port` | Bind address — keep `127.0.0.1` behind a proxy. |
| `hugo` | `theme` | Name of a theme in `hugo-site/themes/` (blank = built-in). |
| `auth` | `password_hash` | Set via `--set-password`. |
| `crossposting.bluesky` | `enabled`, `handle`, `pds_url`, `scope` | Bluesky cross-posting. |
| `crossposting.mastodon` | `enabled`, `instance_url` | Mastodon/GoToSocial cross-posting. |
| `webmentions` | `receive`, `send`, `moderation` | Incoming/outgoing webmentions (**deprecated, off by default**). |
| `feeds` | `posts_per_page`, `include_reply_type` | Feed/listing behaviour. |
| `microblog` | `ping_enabled`, `ping_url` | Optionally ping Micro.blog on publish. |

---

## Connecting to Bluesky

Macroblog speaks **ATProto OAuth 2.0** with DPoP, PKCE and PAR. Crucially it asks
for the **minimum permissions** it needs rather than full account access:

```
atproto                                                      # authenticate (required)
repo:app.bsky.feed.post                                      # create posts AND replies
blob:image/*                                                 # upload media for photo posts
rpc:app.bsky.feed.getTimeline?aud=did:web:api.bsky.app#bsky_appview    # read your following feed (Timeline tab)
rpc:app.bsky.feed.getPostThread?aud=did:web:api.bsky.app#bsky_appview  # read replies so you can answer them (Mentions)
```

The two `rpc:` scopes name the Bluesky **AppView** audience (`?aud=…`). ATProto
requires `rpc:` scopes to declare which service the call is proxied to; without
it the authorization server silently drops the scope and reads come back `403
ScopeMissingError`. If you previously connected before this was set, **reconnect**
Bluesky once so the new read scopes are granted.

It never requests the deprecated broad `transition` generic scope, so Macroblog
**cannot** touch your follows, likes, DMs, profile, or account settings.

1. Enter **any** Bluesky handle in Settings (e.g. `you.bsky.social` or your
   custom domain) and set `crossposting.bluesky.enabled: true`.
2. Click **Connect Bluesky**. You're sent to your own PDS to log in and approve.
3. Done — tokens (and the DPoP key) are stored in the local DB.

If a token later expires, the dashboard shows a **"connection expired —
reconnect"** banner (same for Mastodon); one click re-runs the login.

> If your PDS does not yet support granular scopes, set
> `crossposting.bluesky.scope` to a scope string it accepts. Avoid
> `transition:generic` unless you understand the broad access it grants.

For local development the redirect URI uses `127.0.0.1` (not `localhost`), which
ATProto requires.

## Connecting to Mastodon / GoToSocial

1. Set `crossposting.mastodon.enabled: true` and enter your instance URL in Settings
   (any Mastodon-API-compatible server works, including GoToSocial).
2. Click **Connect Mastodon**. Macroblog registers an app (`read write`),
   sends you to authorize, and stores the token.

Only stable v1 endpoints are used (`/api/v1/statuses`, `/api/v1/media`,
`/api/v1/statuses/:id/context`) and `text/plain` is preferred, so GoToSocial
behaves consistently.

## The Mentions tab

The web admin's **Mentions** tab unifies everything in one inbox:

- **Bluesky & Mastodon replies and @-mentions** — fetched on a 15-minute poll (or
  **Poll replies** on demand) and **answerable inline** — type a reply and it's posted
  back to the right thread on the right platform. Replies you make to your **own** posts
  from your own connected account are filtered out, so the inbox only shows other people.
- **Webmentions** *(deprecated)* — approve/reject incoming mentions when enabled.

---

## Posting

### From the Micro.blog iOS / macOS app

Point the app at your own domain. The app discovers your endpoints from the
`<link rel="...">` tags Macroblog emits (`authorization_endpoint`,
`token_endpoint`, `micropub`, `webmention`). Sign in with your password via the
IndieAuth screen and post as usual. `mp-syndicate-to` targets (Bluesky/Mastodon)
appear automatically when those integrations are enabled.

### From iA Writer / MarsEdit / Quill

Any Micropub client works: give it your site URL, complete IndieAuth, and post.
Macroblog supports notes, articles, photos (with the media endpoint), bookmarks,
replies, scheduled posts (`published` in the future), drafts (`post-status`),
and `update`/`delete`.

### From the web admin

`/admin/` gives you a composer (note / article / photo / bookmark, drag-and-drop
photos, tags, scheduling, cross-post toggles), a posts list, a media library,
the Mentions inbox, and full Settings. The whole admin is mobile-first, so you can
write and publish from a phone — the composer's actions and a bottom tab bar are
built for touch.

---

## Open API (works with existing tools)

Because Macroblog is self-hosted and standards-based, it's meant to be **open and
compatible** with the existing IndieWeb / Micropub ecosystem rather than a closed
silo. The heavy lifting (cross-posting, thread-splitting, media) happens on the
backend, so clients only need to speak Micropub.

Endpoints, all discoverable from your home page's `<link>` tags (and from
`/.well-known/oauth-authorization-server`):

| Endpoint | Purpose |
|---|---|
| `/.well-known/oauth-authorization-server` | IndieAuth / OAuth 2.0 **metadata** (`rel="indieauth-metadata"`) — modern clients auto-configure from this. |
| `/indieauth/auth` | Authorization endpoint (PKCE). |
| `/indieauth/token` | Token endpoint — exchange a code for a bearer token. |
| `/micropub` | Micropub: `GET ?q=config` / `?q=source`, `POST` create/update/delete. |
| `/media` | Micropub **media endpoint** for photo/audio uploads. |

These endpoints send permissive **CORS** headers, so browser-based Micropub
clients (e.g. Quill) and mobile writing apps can talk to your instance
cross-origin. Point any Micropub/IndieAuth client at your site URL, sign in with
your admin password on the IndieAuth screen, and post — `mp-syndicate-to` targets
(Bluesky/Mastodon) appear automatically when those integrations are enabled.

---

## Installing Micro.blog themes

Micro.blog themes are standard Hugo themes:

```bash
git clone <theme-repo> hugo-site/themes/my-theme
```

Set the theme in **Settings → Theme** (or `hugo.theme: "my-theme"`), then
rebuild. Macroblog populates the variables themes expect, sets
`.Site.Params.theme_seconds` for CSS cache-busting, and provides a
`microblog_head.html` overlay partial so IndieWeb tags are injected even when a
theme doesn't include them.

---

## Backups

Your real data is just files + one SQLite DB:

```
macroblog.config.yaml      # config (contains your password hash)
macroblog.db               # post/syndication/webmention state
hugo-site/content/         # every post as Markdown — the source of truth
uploads/                   # media
```

**Easiest:** in the web admin, **Settings → Download backup** gives you a single
`.tar.gz` of all of the above (the DB is snapshotted consistently).

**CLI:**

```bash
bun run macroblog --backup            # writes backups/macroblog-backup-<date>.tar.gz
bun run macroblog --restore <file>    # restores db + content + uploads + config
```

**Manual:** just copy the four paths above somewhere safe.

---

## Updating without losing data

`macroblog.config.yaml`, `macroblog.db`, `hugo-site/content/`, and `uploads/`
are all gitignored, so updates never overwrite them.

```bash
cd ~/macroblog
./update.sh
```

`update.sh` takes a safety backup, fast-forwards the code, reinstalls deps, runs
migrations (additive only), rebuilds, and restarts the service if present. Or
re-run the one-liner installer — it updates an existing checkout in place.

---

## Importing content

Settings → **Import content** brings posts in from several sources. Original
publication dates are preserved, and re-running an import skips posts already
present (idempotent).

- **Micro.blog** — paste your JSON Feed URL, **or upload your "Blog Archive"
  export `.zip` directly** (Settings → Import → choose the `.zip`). The archive
  importer reads the Hugo-style Markdown natively: microposts (no title) become
  notes, titled posts become articles, categories/dates are kept, and bundled
  `uploads/` media is written into your media library with image references
  rewritten to local `/uploads/` paths — no manual file copying.
- **Twitter / X** — upload `tweets.js` from your data export. Only your
  **original** tweets are imported; replies, retweets and blank tweets are
  skipped.
- **RSS/Atom, WordPress (WXR), Instagram** — feed URL or file upload.

**Keep imports separate (e.g. a Tweets page).** Any import can be routed into a
dedicated section by typing a name (e.g. `tweets`) in *"Put these in a separate
section"*. Those posts get their own page at `/tweets/` and are kept **out of
your main feed and archive** — add a nav link to them under Navigation. In the
admin **Posts** list, a section dropdown lets you view and **mass-delete** an
imported collection on its own (select posts and *Delete selected*).

> Posts dropped onto disk (or the old sample post) are reconciled into the
> database on startup so they always show up in the admin and can be deleted.

---

## Development

```bash
bun install
bun run dev        # watch mode
bun test           # full test suite (no external HTTP is mocked)
bunx tsc --noEmit  # type-check
```

Tests run in an isolated sandbox (`.test-sandbox/`) and never touch your real
data, configured via `tests/setup.ts`.

## Architecture

```
src/
  server.ts            Bun.serve entry point
  app.ts               Hono app composition + static serving
  routes/              micropub, indieauth, media, webmention, wellknown,
                       oauth/{bluesky,mastodon}, admin/{api,login}
  services/            hugo build, content (md), syndication, scheduler,
                       reply-poller, webmention-send, backup, crosspost/*
  lib/                 config, indieauth, dpop, tokens, micropub-parser,
                       slugify, middleware
  db/                  bun:sqlite schema + migrations
hugo-site/             Hugo root (config, default theme, content, data)
```

## Troubleshooting

**The admin works but the public site 404s.** The public site is served from
Hugo's `public/` output, so if no build has succeeded yet, every public URL has
nothing to serve. Instead of a bare "Not Found", Macroblog now returns a
**"Your site isn't built yet"** page that includes the last Hugo build error —
read it to see the cause (a missing `hugo` binary, a theme error, or a bad
post). The admin stays reachable at `/admin/` regardless. The Hugo build is
almost always the culprit; builds are atomic (a failed build can't take a
working live site down), so check the error:

```bash
# Docker
docker compose logs macroblog | grep -A 30 "build FAILED"
# or non-Docker (systemd)
journalctl -u macroblog | grep -A 30 "build FAILED"
```

Then trigger a rebuild from the admin (**Settings → Rebuild site**) or
`docker compose restart macroblog`.

**Behind Cloudflare Tunnel / a reverse proxy:** make sure `MACROBLOG_SITE_URL`
(Docker) or `site.url` (config) is your real `https://` domain, then rebuild so
Hugo emits the right absolute URLs.

## Credits

- [Bun](https://bun.sh), [Hono](https://hono.dev), [Hugo](https://gohugo.io)
- Admin UI icons from [Lucide](https://lucide.dev) (ISC), vendored inline — no CDN.

## License

MIT
