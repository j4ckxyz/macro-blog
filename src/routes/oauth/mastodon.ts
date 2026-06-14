import { Hono } from "hono";
import { getConfig } from "../../lib/config.ts";
import { getDb } from "../../db/index.ts";
import { saveToken } from "../../lib/tokens.ts";
import { randomToken } from "../../lib/indieauth.ts";
import type { MastodonAppRow } from "../../db/schema.ts";

export const mastodon = new Hono();

const SCOPES = "read write";

function redirectUri(): string {
  const cfg = getConfig();
  return `${cfg.site.url.replace(/\/+$/, "")}/oauth/mastodon/callback`;
}

const stateStore = new Map<string, { instance: string; createdAt: number }>();

/** Register (or reuse) a Mastodon/GoToSocial app for an instance. */
export async function ensureApp(
  instanceUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<MastodonAppRow> {
  const db = getDb();
  const base = instanceUrl.replace(/\/+$/, "");
  const existing = db
    .query("SELECT * FROM mastodon_apps WHERE instance_url = ?")
    .get(base) as MastodonAppRow | null;
  if (existing) return existing;

  const res = await fetchImpl(`${base}/api/v1/apps`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "Macroblog",
      redirect_uris: redirectUri(),
      scopes: SCOPES,
      website: getConfig().site.url.replace(/\/+$/, ""),
    }),
  });
  if (!res.ok) throw new Error(`app registration failed: ${res.status} ${await res.text()}`);
  const app = (await res.json()) as { client_id: string; client_secret: string };

  db.query(
    "INSERT INTO mastodon_apps (instance_url, client_id, client_secret) VALUES (?, ?, ?)",
  ).run(base, app.client_id, app.client_secret);
  return db.query("SELECT * FROM mastodon_apps WHERE instance_url = ?").get(base) as MastodonAppRow;
}

mastodon.get("/connect", async (c) => {
  const cfg = getConfig();
  const instance = (c.req.query("instance") || cfg.crossposting.mastodon.instance_url || "").replace(/\/+$/, "");
  if (!instance) return c.json({ error: "missing instance" }, 400);

  try {
    const app = await ensureApp(instance);
    const state = randomToken(16);
    stateStore.set(state, { instance, createdAt: Date.now() });

    const authUrl = new URL(`${instance}/oauth/authorize`);
    authUrl.searchParams.set("client_id", app.client_id);
    authUrl.searchParams.set("scope", SCOPES);
    authUrl.searchParams.set("redirect_uri", redirectUri());
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("state", state);
    return c.redirect(authUrl.toString(), 302);
  } catch (err) {
    return c.json({ error: "connect failed", detail: (err as Error).message }, 502);
  }
});

mastodon.get("/callback", async (c) => {
  const code = c.req.query("code");
  const state = c.req.query("state");
  if (!code || !state) return c.json({ error: "missing code/state" }, 400);
  const flow = stateStore.get(state);
  if (!flow) return c.json({ error: "invalid or expired state" }, 400);
  stateStore.delete(state);

  const db = getDb();
  const app = db
    .query("SELECT * FROM mastodon_apps WHERE instance_url = ?")
    .get(flow.instance) as MastodonAppRow | null;
  if (!app) return c.json({ error: "app registration missing" }, 500);

  const res = await fetch(`${flow.instance}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      grant_type: "authorization_code",
      code,
      client_id: app.client_id,
      client_secret: app.client_secret,
      redirect_uri: redirectUri(),
      scope: SCOPES,
    }),
  });
  if (!res.ok) return c.json({ error: "token exchange failed", detail: await res.text() }, 502);
  const tok = (await res.json()) as { access_token: string; scope?: string; token_type?: string };

  saveToken("mastodon", {
    access_token: tok.access_token,
    token_type: tok.token_type ?? "Bearer",
    scope: tok.scope ?? SCOPES,
    extra: { instance: flow.instance },
  });

  return c.html(`<p>Mastodon connected (${flow.instance}). You can close this window.</p>`);
});
