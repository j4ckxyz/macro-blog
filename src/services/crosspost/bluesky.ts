import { getToken, getTokenExtra, saveToken, setReauth } from "../../lib/tokens.ts";
import { dpopFetch, type DpopKeypair } from "../../lib/dpop.ts";
import { refreshBlueskyToken, BSKY_APPVIEW } from "../../routes/oauth/bluesky.ts";
import type { CrosspostPayload, CrosspostResult } from "./types.ts";
import type { NormalizedTimelineItem } from "../timeline.ts";

const MAX_GRAPHEMES = 300;

interface BlueskySession {
  accessToken: string;
  keys: DpopKeypair;
  pds: string;
  did: string;
  nonce?: string;
}

function loadSession(): BlueskySession {
  const token = getToken("bluesky");
  const extra = getTokenExtra("bluesky");
  if (!token?.access_token) throw new Error("bluesky not connected");
  if (!extra.dpop_private_jwk || !extra.dpop_public_jwk) throw new Error("bluesky dpop keys missing");
  if (!extra.pds || !extra.did) throw new Error("bluesky pds/did missing");
  return {
    accessToken: token.access_token,
    keys: { privateJwk: extra.dpop_private_jwk, publicJwk: extra.dpop_public_jwk },
    pds: extra.pds,
    did: extra.did,
    nonce: extra.dpop_nonce,
  };
}

/** Ensure the access token is fresh, refreshing via the OAuth flow if needed. */
async function ensureFreshToken(): Promise<void> {
  const token = getToken("bluesky");
  if (!token) throw new Error("bluesky not connected");
  if (token.expires_at && new Date(token.expires_at).getTime() <= Date.now() + 30_000) {
    try {
      await refreshBlueskyToken();
      setReauth("bluesky", false);
    } catch (err) {
      // Refresh token rejected → the user must reconnect.
      setReauth("bluesky", true);
      throw err;
    }
  }
}

/** Authenticated XRPC call to the user's PDS with DPoP.
 * `proxy` sets the atproto-proxy target for AppView read methods (timeline,
 * threads), which the PDS forwards to the Bluesky AppView. */
async function xrpc(
  session: BlueskySession,
  nsid: string,
  method: "GET" | "POST",
  body?: unknown,
  query?: Record<string, string>,
  proxy?: string,
): Promise<any> {
  let url = `${session.pds}/xrpc/${nsid}`;
  if (query) url += "?" + new URLSearchParams(query).toString();
  const headers: Record<string, string> = {};
  if (body) headers["content-type"] = "application/json";
  if (proxy) headers["atproto-proxy"] = proxy;
  const { res, nonce } = await dpopFetch(url, {
    method,
    keys: session.keys,
    accessToken: session.accessToken,
    dpopNonce: session.nonce,
    headers: Object.keys(headers).length ? headers : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (nonce && nonce !== session.nonce) {
    session.nonce = nonce;
    saveToken("bluesky", { extra: { ...getTokenExtra("bluesky"), dpop_nonce: nonce } });
  }
  if (!res.ok) {
    const body = await res.text();
    if (res.status === 401 || /invalid_token|expired/i.test(body)) {
      setReauth("bluesky", true);
    }
    throw new Error(`xrpc ${nsid} failed: ${res.status} ${body}`);
  }
  setReauth("bluesky", false);
  return res.json();
}

const URL_RE = /https?:\/\/[^\s)]+/g;

/** Build richtext facets (byte-indexed) for links in the text. */
export function buildFacets(text: string): any[] {
  const encoder = new TextEncoder();
  const facets: any[] = [];
  let m: RegExpExecArray | null;
  URL_RE.lastIndex = 0;
  while ((m = URL_RE.exec(text)) !== null) {
    const byteStart = encoder.encode(text.slice(0, m.index)).length;
    const byteEnd = byteStart + encoder.encode(m[0]).length;
    facets.push({
      index: { byteStart, byteEnd },
      features: [{ $type: "app.bsky.richtext.facet#link", uri: m[0] }],
    });
  }
  return facets;
}

function truncateGraphemes(text: string, max: number): string {
  const chars = Array.from(text);
  if (chars.length <= max) return text;
  return chars.slice(0, max - 1).join("") + "…";
}

async function uploadBlob(session: BlueskySession, url: string): Promise<any> {
  const fileRes = await fetch(url);
  if (!fileRes.ok) throw new Error(`failed to fetch image ${url}`);
  const bytes = new Uint8Array(await fileRes.arrayBuffer());
  const contentType = fileRes.headers.get("content-type") || "image/jpeg";
  const { res, nonce } = await dpopFetch(`${session.pds}/xrpc/com.atproto.repo.uploadBlob`, {
    method: "POST",
    keys: session.keys,
    accessToken: session.accessToken,
    dpopNonce: session.nonce,
    headers: { "content-type": contentType },
    body: bytes,
  });
  if (nonce) session.nonce = nonce;
  if (!res.ok) throw new Error(`uploadBlob failed: ${res.status} ${await res.text()}`);
  const json = (await res.json()) as { blob: unknown };
  return json.blob;
}

/** Build the post record (exported for testing without network). */
export async function buildPostRecord(
  payload: CrosspostPayload,
  session: BlueskySession,
): Promise<any> {
  const record: any = {
    $type: "app.bsky.feed.post",
    createdAt: new Date().toISOString(),
  };

  if (payload.type === "article" && payload.title) {
    const text = truncateGraphemes(`${payload.title}\n\n${payload.url}`, MAX_GRAPHEMES);
    record.text = text;
    record.facets = buildFacets(text);
    record.embed = {
      $type: "app.bsky.embed.external",
      external: {
        uri: payload.url,
        title: payload.title,
        description: truncateGraphemes(payload.text, 300),
      },
    };
    return record;
  }

  if (payload.photos.length) {
    const images = [];
    for (const photo of payload.photos.slice(0, 4)) {
      const blob = await uploadBlob(session, photo.url);
      images.push({ alt: photo.alt ?? "", image: blob });
    }
    record.text = truncateGraphemes(payload.text, MAX_GRAPHEMES);
    record.facets = buildFacets(record.text);
    record.embed = { $type: "app.bsky.embed.images", images };
    return record;
  }

  // Short note (possibly truncated with a "read more" link).
  if (Array.from(payload.text).length > MAX_GRAPHEMES) {
    const text = truncateGraphemes(`${payload.text}\n\n${payload.url}`, MAX_GRAPHEMES);
    record.text = text;
    record.facets = buildFacets(text);
    record.embed = {
      $type: "app.bsky.embed.external",
      external: { uri: payload.url, title: payload.title ?? "Read more", description: "" },
    };
  } else {
    record.text = payload.text;
    record.facets = buildFacets(payload.text);
  }
  return record;
}

export async function crosspostBluesky(payload: CrosspostPayload): Promise<CrosspostResult> {
  await ensureFreshToken();
  const session = loadSession();
  const record = await buildPostRecord(payload, session);

  const result = await xrpc(session, "com.atproto.repo.createRecord", "POST", {
    repo: session.did,
    collection: "app.bsky.feed.post",
    record,
  });

  const uri: string = result.uri; // at://did/app.bsky.feed.post/rkey
  const rkey = uri.split("/").pop();
  const handle = getTokenExtra("bluesky").handle || session.did;
  const remoteUrl = `https://bsky.app/profile/${handle}/post/${rkey}`;
  return { remoteId: uri, remoteUrl };
}

/** Post a reply to a Bluesky post (used by the unified Mentions tab). */
export async function replyBluesky(
  parent: { uri: string; cid: string },
  root: { uri: string; cid: string },
  text: string,
): Promise<{ remoteId: string; remoteUrl: string }> {
  await ensureFreshToken();
  const session = loadSession();
  const record: any = {
    $type: "app.bsky.feed.post",
    text,
    facets: buildFacets(text),
    createdAt: new Date().toISOString(),
    reply: { root, parent },
  };
  const result = await xrpc(session, "com.atproto.repo.createRecord", "POST", {
    repo: session.did,
    collection: "app.bsky.feed.post",
    record,
  });
  const rkey = (result.uri as string).split("/").pop();
  const handle = getTokenExtra("bluesky").handle || session.did;
  return { remoteId: result.uri, remoteUrl: `https://bsky.app/profile/${handle}/post/${rkey}` };
}

/** Fetch the authenticated user's following feed (home timeline). */
export async function fetchBlueskyTimeline(limit = 50): Promise<NormalizedTimelineItem[]> {
  await ensureFreshToken();
  const session = loadSession();
  const result = await xrpc(session, "app.bsky.feed.getTimeline", "GET", undefined, {
    limit: String(limit),
  }, BSKY_APPVIEW);
  const items: NormalizedTimelineItem[] = [];
  for (const entry of result?.feed ?? []) {
    const p = entry.post;
    if (!p) continue;
    const handle = p.author?.handle;
    const rkey = (p.uri as string).split("/").pop();
    const media = (p.embed?.images ?? p.embed?.media?.images ?? []).map((im: any) => ({
      url: im.fullsize || im.thumb || "",
      alt: im.alt || "",
    }));
    const repost = entry.reason?.$type?.includes("reasonRepost")
      ? entry.reason?.by?.displayName || entry.reason?.by?.handle
      : null;
    items.push({
      platform: "bluesky",
      remoteId: p.uri,
      author: p.author?.displayName || handle || "",
      authorHandle: handle ? "@" + handle : "",
      avatar: p.author?.avatar || "",
      content: p.record?.text || "",
      url: handle ? `https://bsky.app/profile/${handle}/post/${rkey}` : "",
      media,
      repostedBy: repost,
      createdAt: p.record?.createdAt || p.indexedAt || new Date().toISOString(),
    });
  }
  return items;
}

/** Fetch replies to a syndicated post via getPostThread, plus the thread root. */
export async function fetchBlueskyReplies(
  atUri: string,
): Promise<{ root: { uri: string; cid: string } | null; replies: any[] }> {
  await ensureFreshToken();
  const session = loadSession();
  const result = await xrpc(session, "app.bsky.feed.getPostThread", "GET", undefined, {
    uri: atUri,
    depth: "1",
  }, BSKY_APPVIEW);
  const post = result?.thread?.post;
  const root = post ? { uri: post.uri, cid: post.cid } : null;
  return { root, replies: result?.thread?.replies ?? [] };
}
