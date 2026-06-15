import { Hono } from "hono";
import { getConfig } from "../../lib/config.ts";
import { randomToken, base64url, s256Challenge } from "../../lib/indieauth.ts";
import { generateDpopKeypair, dpopFetch, type DpopKeypair } from "../../lib/dpop.ts";
import { saveToken, getToken, getTokenExtra } from "../../lib/tokens.ts";

/**
 * ATProto (Bluesky) OAuth 2.0 with DPoP + PAR + PKCE.
 *
 * Hard rules (enforced here):
 *  - LEAST PRIVILEGE: request only fine-grained granular scopes, never the
 *    deprecated broad `transition` generic scope (which would grant Macroblog
 *    full read/write access to the entire account). See BLUESKY_SCOPES below.
 *  - the redirect URI uses 127.0.0.1 (not localhost) for local dev.
 *  - DPoP-bound access tokens; client auth method is "none".
 */

export const bluesky = new Hono();

/**
 * Minimal granular permission scopes Macroblog actually needs — and ONLY these:
 *  - `atproto`                          authenticate (required)
 *  - `repo:app.bsky.feed.post`          create posts AND replies
 *  - `blob:image/*`                     upload media for photo posts
 *  - `rpc:app.bsky.feed.getTimeline`    read your following feed (Timeline tab)
 *  - `rpc:app.bsky.feed.getPostThread`  read replies (Mentions tab)
 *
 * This intentionally does NOT grant access to follows, likes, DMs, profile
 * edits, account settings, or arbitrary record types. Override via
 * `crossposting.bluesky.scope` only if your PDS lacks granular scope support.
 */
export const BLUESKY_SCOPES = [
  "atproto",
  "repo:app.bsky.feed.post",
  "blob:image/*",
  "rpc:app.bsky.feed.getTimeline",
  "rpc:app.bsky.feed.getPostThread",
].join(" ");

export function blueskyScope(): string {
  const cfg = getConfig();
  return (cfg.crossposting.bluesky as any).scope || BLUESKY_SCOPES;
}

// Transient per-flow state (single-user, in-memory is fine).
interface FlowState {
  pkceVerifier: string;
  keys: DpopKeypair;
  authServer: string;
  tokenEndpoint: string;
  pds: string;
  did: string;
  handle: string;
  redirectUri: string;
  createdAt: number;
}
const flows = new Map<string, FlowState>();

export function clientId(): string {
  const cfg = getConfig();
  return `${cfg.site.url.replace(/\/+$/, "")}/oauth/bluesky/client-metadata.json`;
}

export function redirectUri(): string {
  const cfg = getConfig();
  // For local development the redirect URI MUST use 127.0.0.1, never localhost.
  const base = cfg.site.url.replace(/\/+$/, "").replace("//localhost", "//127.0.0.1");
  return `${base}/oauth/bluesky/callback`;
}

export function clientMetadata() {
  const cfg = getConfig();
  return {
    client_id: clientId(),
    client_name: "Macroblog",
    client_uri: cfg.site.url.replace(/\/+$/, ""),
    redirect_uris: [redirectUri()],
    scope: blueskyScope(),
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    application_type: "web",
    dpop_bound_access_tokens: true,
    token_endpoint_auth_method: "none",
  };
}

bluesky.get("/client-metadata.json", (c) => c.json(clientMetadata()));

/** Resolve a handle to its DID, PDS, and authorization server endpoints. */
export async function resolveHandle(handle: string, pdsHint: string) {
  // 1. handle -> DID
  const resolveUrl = `${pdsHint.replace(/\/+$/, "")}/xrpc/com.atproto.identity.resolveHandle?handle=${encodeURIComponent(handle)}`;
  const r = await fetch(resolveUrl);
  if (!r.ok) throw new Error(`resolveHandle failed: ${r.status}`);
  const { did } = (await r.json()) as { did: string };

  // 2. DID -> DID document -> PDS service endpoint
  const didDocUrl = did.startsWith("did:plc:")
    ? `https://plc.directory/${did}`
    : `https://${did.replace("did:web:", "")}/.well-known/did.json`;
  const docRes = await fetch(didDocUrl);
  if (!docRes.ok) throw new Error(`did doc fetch failed: ${docRes.status}`);
  const doc = (await docRes.json()) as any;
  const pdsService = (doc.service ?? []).find((s: any) => s.id === "#atproto_pds" || s.type === "AtprotoPersonalDataServer");
  const pds = pdsService?.serviceEndpoint ?? pdsHint;

  // 3. PDS -> protected resource metadata -> authorization server
  const prRes = await fetch(`${pds.replace(/\/+$/, "")}/.well-known/oauth-protected-resource`);
  let authServer = pds;
  if (prRes.ok) {
    const pr = (await prRes.json()) as { authorization_servers?: string[] };
    if (pr.authorization_servers?.length) authServer = pr.authorization_servers[0];
  }

  // 4. authorization server metadata
  const asRes = await fetch(`${authServer.replace(/\/+$/, "")}/.well-known/oauth-authorization-server`);
  if (!asRes.ok) throw new Error(`authorization server metadata failed: ${asRes.status}`);
  const meta = (await asRes.json()) as any;

  return {
    did,
    pds,
    authServer,
    authorizationEndpoint: meta.authorization_endpoint as string,
    tokenEndpoint: meta.token_endpoint as string,
    parEndpoint: meta.pushed_authorization_request_endpoint as string,
  };
}

bluesky.get("/connect", async (c) => {
  const cfg = getConfig();
  const handle = c.req.query("handle") || cfg.crossposting.bluesky.handle;
  if (!handle) return c.json({ error: "missing handle" }, 400);

  try {
    const resolved = await resolveHandle(handle, cfg.crossposting.bluesky.pds_url);
    const keys = await generateDpopKeypair();
    const state = randomToken(16);
    const pkceVerifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
    const challenge = await s256Challenge(pkceVerifier);

    // Pushed Authorization Request (PAR), DPoP-signed.
    const parBody = new URLSearchParams({
      client_id: clientId(),
      response_type: "code",
      redirect_uri: redirectUri(),
      scope: blueskyScope(),
      state,
      code_challenge: challenge,
      code_challenge_method: "S256",
      login_hint: handle,
    });
    const { res } = await dpopFetch(resolved.parEndpoint, {
      method: "POST",
      keys,
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: parBody.toString(),
    });
    if (!res.ok) {
      return c.json({ error: "PAR failed", detail: await res.text() }, 502);
    }
    const par = (await res.json()) as { request_uri: string };

    flows.set(state, {
      pkceVerifier,
      keys,
      authServer: resolved.authServer,
      tokenEndpoint: resolved.tokenEndpoint,
      pds: resolved.pds,
      did: resolved.did,
      handle,
      redirectUri: redirectUri(),
      createdAt: Date.now(),
    });

    const authUrl = new URL(resolved.authorizationEndpoint);
    authUrl.searchParams.set("client_id", clientId());
    authUrl.searchParams.set("request_uri", par.request_uri);
    return c.redirect(authUrl.toString(), 302);
  } catch (err) {
    return c.json({ error: "connect failed", detail: (err as Error).message }, 502);
  }
});

bluesky.get("/callback", async (c) => {
  const code = c.req.query("code");
  const state = c.req.query("state");
  if (!code || !state) return c.json({ error: "missing code/state" }, 400);
  const flow = flows.get(state);
  if (!flow) return c.json({ error: "invalid or expired state" }, 400);
  flows.delete(state);

  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: flow.redirectUri,
    client_id: clientId(),
    code_verifier: flow.pkceVerifier,
  });
  const { res, nonce } = await dpopFetch(flow.tokenEndpoint, {
    method: "POST",
    keys: flow.keys,
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!res.ok) {
    return c.json({ error: "token exchange failed", detail: await res.text() }, 502);
  }
  const tok = (await res.json()) as any;
  const expiresAt = tok.expires_in
    ? new Date(Date.now() + tok.expires_in * 1000).toISOString()
    : null;

  saveToken("bluesky", {
    access_token: tok.access_token,
    refresh_token: tok.refresh_token,
    token_type: tok.token_type ?? "DPoP",
    expires_at: expiresAt,
    scope: tok.scope ?? blueskyScope(),
    extra: {
      dpop_private_jwk: flow.keys.privateJwk,
      dpop_public_jwk: flow.keys.publicJwk,
      dpop_nonce: nonce,
      token_endpoint: flow.tokenEndpoint,
      pds: flow.pds,
      did: tok.sub ?? flow.did,
      handle: flow.handle,
    },
  });

  return c.html(`<p>Bluesky connected as ${flow.handle}. You can close this window.</p>`);
});

/** Refresh the Bluesky access token using the stored refresh token + DPoP. */
export async function refreshBlueskyToken(): Promise<void> {
  const token = getToken("bluesky");
  const extra = getTokenExtra("bluesky");
  if (!token?.refresh_token) throw new Error("no bluesky refresh token");
  const keys: DpopKeypair = { privateJwk: extra.dpop_private_jwk, publicJwk: extra.dpop_public_jwk };
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: token.refresh_token,
    client_id: clientId(),
  });
  const { res, nonce } = await dpopFetch(extra.token_endpoint, {
    method: "POST",
    keys,
    accessToken: undefined,
    dpopNonce: extra.dpop_nonce,
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!res.ok) throw new Error(`bluesky refresh failed: ${res.status} ${await res.text()}`);
  const tok = (await res.json()) as any;
  saveToken("bluesky", {
    access_token: tok.access_token,
    refresh_token: tok.refresh_token ?? token.refresh_token,
    expires_at: tok.expires_in ? new Date(Date.now() + tok.expires_in * 1000).toISOString() : null,
    extra: { ...extra, dpop_nonce: nonce ?? extra.dpop_nonce },
  });
}
