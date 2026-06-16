import { getToken, getTokenExtra, saveToken, setReauth } from "../../lib/tokens.ts";
import { getConfig } from "../../lib/config.ts";
import { dpopFetch, type DpopKeypair } from "../../lib/dpop.ts";
import { refreshBlueskyToken } from "../../routes/oauth/bluesky.ts";
import type { CrosspostPayload, CrosspostResult, NormalizedMention } from "./types.ts";
import type { NormalizedTimelineItem } from "../timeline.ts";
import { splitPostIntoThread } from "./thread.ts";

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

/** Authenticated XRPC call to the user's PDS with DPoP. */
async function xrpc(
  session: BlueskySession,
  nsid: string,
  method: "GET" | "POST",
  body?: unknown,
  query?: Record<string, string>,
): Promise<any> {
  let url = `${session.pds}/xrpc/${nsid}`;
  if (query) url += "?" + new URLSearchParams(query).toString();
  const { res, nonce } = await dpopFetch(url, {
    method,
    keys: session.keys,
    accessToken: session.accessToken,
    dpopNonce: session.nonce,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (nonce && nonce !== session.nonce) {
    session.nonce = nonce;
    saveToken("bluesky", { extra: { ...getTokenExtra("bluesky"), dpop_nonce: nonce } });
  }
  if (!res.ok) {
    const body = await res.text();
    // 401/expired → token dead. A 403 ScopeMissingError means the stored token
    // was granted fewer scopes than we now request (e.g. older grants without
    // the read scopes) — the user must reconnect to pick up the new scopes.
    if (res.status === 401 || /invalid_token|expired/i.test(body) || /ScopeMissing/i.test(body)) {
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

const HASHTAG_RE = /(^|[\s(])#([\p{L}\p{N}_]*[\p{L}\p{N}_-]+)/gu;

/** Build richtext tag facets (byte-indexed) for #hashtags in the text. */
export function buildTagFacets(text: string): any[] {
  const encoder = new TextEncoder();
  const facets: any[] = [];
  let m: RegExpExecArray | null;
  HASHTAG_RE.lastIndex = 0;
  while ((m = HASHTAG_RE.exec(text)) !== null) {
    const lead = m[1] ?? "";
    const tag = m[2];
    if (!tag || /^\d+$/.test(tag)) continue; // skip purely-numeric (#1)
    const hashIndex = m.index + lead.length;
    const byteStart = encoder.encode(text.slice(0, hashIndex)).length;
    const byteEnd = byteStart + encoder.encode("#" + tag).length;
    facets.push({
      index: { byteStart, byteEnd },
      features: [{ $type: "app.bsky.richtext.facet#tag", tag }],
    });
  }
  return facets;
}

/** Sanitise category names into Bluesky tag strings (no leading #, max 8). */
export function categoriesToTags(categories: string[] | undefined): string[] {
  if (!categories?.length) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of categories) {
    const tag = String(raw).replace(/^#+/, "").replace(/\s+/g, "").trim();
    if (!tag) continue;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
    if (out.length >= 8) break; // Bluesky caps a post at 8 tags.
  }
  return out;
}

function truncateGraphemes(text: string, max: number): string {
  const chars = Array.from(text);
  if (chars.length <= max) return text;
  return chars.slice(0, max - 1).join("") + "…";
}

export function markdownToRichText(md: string): { text: string; facets: any[] } {
  const trimmed = md.trim();
  if (trimmed.startsWith("```") && trimmed.endsWith("```")) {
    return { text: trimmed, facets: [] };
  }

  let working = trimmed.replace(/!\[[^\]]*\]\([^)]*\)/g, "");

  working = working
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^>\s?/gm, "")
    .replace(/(\*\*|__)(.*?)\1/g, "$2")
    .replace(/(\*|_)(.*?)\1/g, "$2")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\r/g, "");

  const facets: any[] = [];
  const encoder = new TextEncoder();
  let resultText = "";
  let lastIndex = 0;

  const linkRegex = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g;
  let match: RegExpExecArray | null;

  while ((match = linkRegex.exec(working)) !== null) {
    const beforeText = working.slice(lastIndex, match.index);
    resultText += beforeText;

    const linkText = match[1];
    const linkUrl = match[2];

    const byteStart = encoder.encode(resultText).length;
    resultText += linkText;
    const byteEnd = encoder.encode(resultText).length;

    facets.push({
      index: { byteStart, byteEnd },
      features: [{ $type: "app.bsky.richtext.facet#link", uri: linkUrl }],
    });

    lastIndex = linkRegex.lastIndex;
  }

  resultText += working.slice(lastIndex);

  const rawFacets = buildFacets(resultText);
  for (const raw of rawFacets) {
    const start = raw.index.byteStart;
    const end = raw.index.byteEnd;
    const overlap = facets.some(f => (start >= f.index.byteStart && start < f.index.byteEnd) || (end > f.index.byteStart && end <= f.index.byteEnd));
    if (!overlap) {
      facets.push(raw);
    }
  }

  // Hashtags written in the body become proper Bluesky tag facets (skipping any
  // that fall inside an existing link facet, e.g. a URL fragment like #section).
  for (const tagFacet of buildTagFacets(resultText)) {
    const { byteStart, byteEnd } = tagFacet.index;
    const overlap = facets.some(f => (byteStart >= f.index.byteStart && byteStart < f.index.byteEnd) || (byteEnd > f.index.byteStart && byteEnd <= f.index.byteEnd));
    if (!overlap) facets.push(tagFacet);
  }

  facets.sort((a, b) => a.index.byteStart - b.index.byteStart);

  return { text: resultText, facets };
}

function truncateRichText(text: string, facets: any[], max: number): { text: string; facets: any[] } {
  const chars = Array.from(text);
  if (chars.length <= max) return { text, facets };
  
  const truncatedText = chars.slice(0, max - 1).join("") + "…";
  const encoder = new TextEncoder();
  const maxByteLen = encoder.encode(truncatedText).length;

  const adjustedFacets = facets
    .map(f => {
      if (f.index.byteStart >= maxByteLen) return null;
      const byteEnd = Math.min(f.index.byteEnd, maxByteLen);
      if (byteEnd <= f.index.byteStart) return null;
      return {
        ...f,
        index: { byteStart: f.index.byteStart, byteEnd },
      };
    })
    .filter(Boolean) as any[];

  return { text: truncatedText, facets: adjustedFacets };
}

interface LinkMetadata {
  title: string;
  description: string;
  imageUrl?: string;
}

async function fetchLinkMetadata(url: string): Promise<LinkMetadata> {
  try {
    const res = await fetch(url, { headers: { "User-Agent": "Macroblog/1.0" } });
    if (!res.ok) return { title: "", description: "" };
    const html = await res.text();
    
    let title = "";
    const titleMatch = html.match(/<title>([^<]+)<\/title>/i);
    if (titleMatch) title = titleMatch[1].trim();

    const ogTitleMatch = html.match(/<meta\s+property=["']og:title["']\s+content=["']([^"']+)["']/i) ||
                         html.match(/<meta\s+content=["']([^"']+)["']\s+property=["']og:title["']/i);
    if (ogTitleMatch) title = ogTitleMatch[1].trim();

    let description = "";
    const descMatch = html.match(/<meta\s+name=["']description["']\s+content=["']([^"']+)["']/i) ||
                      html.match(/<meta\s+content=["']([^"']+)["']\s+name=["']description["']/i);
    if (descMatch) description = descMatch[1].trim();

    const ogDescMatch = html.match(/<meta\s+property=["']og:description["']\s+content=["']([^"']+)["']/i) ||
                        html.match(/<meta\s+content=["']([^"']+)["']\s+property=["']og:description["']/i);
    if (ogDescMatch) description = ogDescMatch[1].trim();

    let imageUrl: string | undefined;
    const ogImageMatch = html.match(/<meta\s+property=["']og:image["']\s+content=["']([^"']+)["']/i) ||
                         html.match(/<meta\s+content=["']([^"']+)["']\s+property=["']og:image["']/i);
    if (ogImageMatch) imageUrl = ogImageMatch[1].trim();

    if (imageUrl && !/^https?:\/\//.test(imageUrl)) {
      imageUrl = new URL(imageUrl, url).toString();
    }

    return { title, description, imageUrl };
  } catch (err) {
    console.error(`[bluesky] failed to fetch link metadata for ${url}:`, err);
    return { title: "", description: "" };
  }
}

function absolutize(url: string): string {
  if (/^https?:\/\//.test(url)) return url;
  return getConfig().site.url.replace(/\/+$/, "") + (url.startsWith("/") ? url : "/" + url);
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
  const lang = payload.lang || getConfig().site.language || "en";
  const record: any = {
    $type: "app.bsky.feed.post",
    createdAt: new Date().toISOString(),
    langs: [lang],
  };

  // Categories become hidden Bluesky tags: indexed for search/feeds but not
  // shown in the post text (the post's #hashtags are handled as facets above).
  const hiddenTags = categoriesToTags(payload.categories);
  if (hiddenTags.length) record.tags = hiddenTags;

  const linkBack = payload.linkBack === true;

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

  let { text, facets } = markdownToRichText(payload.markdown || payload.text);

  const hasVideo = payload.photos.some(p => p.url.match(/\.(mp4|webm|ogg|mov)$/i));
  if (payload.photos.length && !hasVideo) {
    const images = [];
    for (const photo of payload.photos.slice(0, 4)) {
      const blob = await uploadBlob(session, photo.url);
      const imgObj: any = { alt: photo.alt ?? "", image: blob };
      if (photo.width && photo.height) {
        imgObj.aspectRatio = {
          width: photo.width,
          height: photo.height,
        };
      }
      images.push(imgObj);
    }
    
    if (linkBack) {
      const truncated = truncateRichText(text, facets, MAX_GRAPHEMES - 3);
      text = truncated.text;
      facets = truncated.facets;
      
      const encoder = new TextEncoder();
      const byteStart = encoder.encode(text + " ").length;
      const byteEnd = byteStart + encoder.encode("🔗").length;
      text += " 🔗";
      facets.push({
        index: { byteStart, byteEnd },
        features: [{ $type: "app.bsky.richtext.facet#link", uri: payload.url }],
      });
    } else {
      const truncated = truncateRichText(text, facets, MAX_GRAPHEMES);
      text = truncated.text;
      facets = truncated.facets;
    }

    record.text = text;
    record.facets = facets;
    record.embed = { $type: "app.bsky.embed.images", images };
    return record;
  }

  if (hasVideo) {
    if (linkBack) {
      const truncated = truncateRichText(text, facets, MAX_GRAPHEMES - 3);
      text = truncated.text;
      facets = truncated.facets;
      
      const encoder = new TextEncoder();
      const byteStart = encoder.encode(text + " ").length;
      const byteEnd = byteStart + encoder.encode("🔗").length;
      text += " 🔗";
      facets.push({
        index: { byteStart, byteEnd },
        features: [{ $type: "app.bsky.richtext.facet#link", uri: payload.url }],
      });
    } else {
      const truncated = truncateRichText(text, facets, MAX_GRAPHEMES);
      text = truncated.text;
      facets = truncated.facets;
    }

    record.text = text;
    record.facets = facets;
    record.embed = {
      $type: "app.bsky.embed.external",
      external: {
        uri: payload.url,
        title: payload.title || "Video Post",
        description: truncateGraphemes(payload.text || "Watch the video on my blog", 300),
      },
    };
    return record;
  }

  if (linkBack) {
    const truncated = truncateRichText(text, facets, MAX_GRAPHEMES - 3);
    text = truncated.text;
    facets = truncated.facets;
    
    const encoder = new TextEncoder();
    const byteStart = encoder.encode(text + " ").length;
    const byteEnd = byteStart + encoder.encode("🔗").length;
    text += " 🔗";
    facets.push({
      index: { byteStart, byteEnd },
      features: [{ $type: "app.bsky.richtext.facet#link", uri: payload.url }],
    });
    record.text = text;
    record.facets = facets;
  } else {
    if (Array.from(text).length > MAX_GRAPHEMES) {
      const truncated = truncateRichText(text + `\n\n${payload.url}`, facets, MAX_GRAPHEMES);
      record.text = truncated.text;
      record.facets = truncated.facets;
      record.embed = {
        $type: "app.bsky.embed.external",
        external: { uri: payload.url, title: payload.title ?? "Read more", description: "" },
      };
    } else {
      record.text = text;
      record.facets = facets;
    }
  }

  // If linking anything, and no media attached, add the embed image card for bluesky posts.
  if (!record.embed) {
    const linkFeatures = facets.flatMap(f => f.features || []).filter(feat => feat.$type === "app.bsky.richtext.facet#link");
    const firstLinkUrl = linkFeatures.length > 0 ? linkFeatures[0].uri : null;
    
    if (firstLinkUrl) {
      let meta: LinkMetadata;
      if (firstLinkUrl === payload.url) {
        const bannerUrl = getConfig().site.banner || getConfig().site.avatar || "";
        meta = {
          title: payload.title || getConfig().site.title,
          description: truncateGraphemes(payload.text, 200),
          imageUrl: bannerUrl ? absolutize(bannerUrl) : undefined,
        };
      } else {
        meta = await fetchLinkMetadata(firstLinkUrl);
      }
      
      const external: any = {
        uri: firstLinkUrl,
        title: meta.title || "Link",
        description: meta.description || "",
      };
      
      if (meta.imageUrl) {
        try {
          const thumbBlob = await uploadBlob(session, meta.imageUrl);
          external.thumb = thumbBlob;
        } catch (err) {
          console.error(`[bluesky] failed to upload link thumbnail ${meta.imageUrl}:`, err);
        }
      }
      
      record.embed = {
        $type: "app.bsky.embed.external",
        external,
      };
    }
  }

  return record;
}

export async function crosspostBluesky(payload: CrosspostPayload): Promise<CrosspostResult> {
  await ensureFreshToken();
  const session = loadSession();

  let chunks: string[] = [];
  if (payload.type === "post") {
    const limit = 280;
    const bodyText = payload.markdown || payload.text;
    chunks = splitPostIntoThread(bodyText, limit, payload.url, payload.linkBack === true);
  }

  if (chunks.length <= 1) {
    const record = await buildPostRecord(payload, session);
    const result = await xrpc(session, "com.atproto.repo.createRecord", "POST", {
      repo: session.did,
      collection: "app.bsky.feed.post",
      record,
    });
    const uri: string = result.uri;
    const rkey = uri.split("/").pop();
    const handle = getTokenExtra("bluesky").handle || session.did;
    const remoteUrl = `https://bsky.app/profile/${handle}/post/${rkey}`;
    return { remoteId: uri, remoteUrl };
  }

  let firstUri = "";
  let firstCid = "";
  let firstUrl = "";
  let prevUri = "";
  let prevCid = "";

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const chunkPayload: CrosspostPayload = {
      ...payload,
      text: chunk,
      markdown: chunk,
      photos: i === 0 ? payload.photos : [],
      categories: i === 0 ? payload.categories : [],
      linkBack: false,
    };

    const record = await buildPostRecord(chunkPayload, session);
    if (i > 0) {
      record.reply = {
        root: { uri: firstUri, cid: firstCid },
        parent: { uri: prevUri, cid: prevCid },
      };
    }

    const result = await xrpc(session, "com.atproto.repo.createRecord", "POST", {
      repo: session.did,
      collection: "app.bsky.feed.post",
      record,
    });

    const uri: string = result.uri;
    const cid: string = result.cid;

    if (i === 0) {
      firstUri = uri;
      firstCid = cid;
      const rkey = uri.split("/").pop();
      const handle = getTokenExtra("bluesky").handle || session.did;
      firstUrl = `https://bsky.app/profile/${handle}/post/${rkey}`;
    }

    prevUri = uri;
    prevCid = cid;
  }

  return { remoteId: firstUri, remoteUrl: firstUrl };
}


/**
 * Post a (possibly multi-part) reply thread to a Bluesky post. Each chunk
 * replies to the previous one, keeping the same thread root. Returns the first
 * post's id/url. Used by the Mentions inbox for longer, auto-chunked replies.
 */
export async function replyBlueskyThread(
  parent: { uri: string; cid: string },
  root: { uri: string; cid: string },
  texts: string[],
): Promise<{ remoteId: string; remoteUrl: string }> {
  await ensureFreshToken();
  const session = loadSession();
  const handle = getTokenExtra("bluesky").handle || session.did;
  let firstUri = "";
  let firstUrl = "";
  let curParent = parent;
  for (let i = 0; i < texts.length; i++) {
    const { text, facets } = markdownToRichText(texts[i]);
    const record: any = {
      $type: "app.bsky.feed.post",
      text,
      facets,
      createdAt: new Date().toISOString(),
      reply: { root, parent: curParent },
    };
    const result = await xrpc(session, "com.atproto.repo.createRecord", "POST", {
      repo: session.did,
      collection: "app.bsky.feed.post",
      record,
    });
    const rkey = (result.uri as string).split("/").pop();
    if (i === 0) {
      firstUri = result.uri;
      firstUrl = `https://bsky.app/profile/${handle}/post/${rkey}`;
    }
    curParent = { uri: result.uri, cid: result.cid };
  }
  return { remoteId: firstUri, remoteUrl: firstUrl };
}

/** Fetch the authenticated user's following feed (home timeline). */
export async function fetchBlueskyTimeline(limit = 50): Promise<NormalizedTimelineItem[]> {
  await ensureFreshToken();
  const session = loadSession();
  const result = await xrpc(session, "app.bsky.feed.getTimeline", "GET", undefined, {
    limit: String(limit),
  });
  const items: NormalizedTimelineItem[] = [];
  for (const entry of result?.feed ?? []) {
    const p = entry.post;
    if (!p) continue;
    const handle = p.author?.handle;
    const rkey = (p.uri as string).split("/").pop();
    const rawImages = p.embed?.images ?? p.embed?.media?.images ?? p.embed?.items ?? p.embed?.media?.items ?? [];
    const media = rawImages.map((im: any) => ({
      url: im.fullsize || im.thumb || "",
      alt: im.alt || "",
    }));
    const repost = entry.reason?.$type?.includes("reasonRepost")
      ? entry.reason?.by?.displayName || entry.reason?.by?.handle
      : null;
    const isReply = !!entry.reply;

    let embed: any = null;
    const embedObj = p.embed;
    if (embedObj) {
      const type = embedObj.$type;
      if (type === "app.bsky.embed.external#view") {
        if (embedObj.external) {
          embed = {
            type: "link",
            uri: embedObj.external.uri,
            title: embedObj.external.title || "",
            description: embedObj.external.description || "",
            thumb: embedObj.external.thumb || null,
          };
        }
      } else if (
        type === "app.bsky.embed.record#view" ||
        type === "app.bsky.embed.recordWithMedia#view"
      ) {
        const recordView = type === "app.bsky.embed.recordWithMedia#view"
          ? embedObj.record?.record
          : embedObj.record;

        if (recordView && recordView.$type === "app.bsky.embed.record#viewRecord") {
          const recHandle = recordView.author?.handle;
          const recRkey = (recordView.uri as string).split("/").pop();
          const recRawImages = recordView.embeds?.[0]?.images || recordView.embeds?.[0]?.media?.images || recordView.embeds?.[0]?.items || recordView.embeds?.[0]?.media?.items || [];
          const recMedia = recRawImages.map((im: any) => ({
            url: im.fullsize || im.thumb || "",
            alt: im.alt || "",
          }));

          embed = {
            type: "quote",
            uri: recordView.uri,
            author: recordView.author?.displayName || recHandle || "",
            authorHandle: recHandle ? "@" + recHandle : "",
            avatar: recordView.author?.avatar || "",
            content: recordView.value?.text || "",
            createdAt: recordView.value?.createdAt || recordView.indexedAt || "",
            url: recHandle ? `https://bsky.app/profile/${recHandle}/post/${recRkey}` : "",
            media: recMedia,
          };
        }
      }
    }

    items.push({
      platform: "bluesky",
      remoteId: p.uri,
      remoteCid: p.cid,
      rootUri: entry.reply?.root?.uri || p.uri,
      rootCid: entry.reply?.root?.cid || p.cid,
      author: p.author?.displayName || handle || "",
      authorHandle: handle ? "@" + handle : "",
      avatar: p.author?.avatar || "",
      content: p.record?.text || "",
      url: handle ? `https://bsky.app/profile/${handle}/post/${rkey}` : "",
      media,
      repostedBy: repost,
      createdAt: p.record?.createdAt || p.indexedAt || new Date().toISOString(),
      isReply,
      embed,
    });
  }
  return items;
}

/** Normalize a hydrated Bluesky post view into inline media + a link/quote embed. */
function normalizeBlueskyPostView(p: any): { media: { url: string; alt?: string; type?: string }[]; embed: any | null } {
  const rawImages = p.embed?.images ?? p.embed?.media?.images ?? [];
  const media = rawImages.map((im: any) => ({ url: im.fullsize || im.thumb || "", alt: im.alt || "", type: "image" }));
  if (p.embed?.$type?.includes("video") && (p.embed?.playlist || p.embed?.thumbnail)) {
    media.push({ url: p.embed.thumbnail || p.embed.playlist, alt: "", type: "video" });
  }
  let embed: any = null;
  const embedObj = p.embed;
  if (embedObj) {
    const type = embedObj.$type;
    if (type === "app.bsky.embed.external#view" && embedObj.external) {
      embed = {
        type: "link",
        uri: embedObj.external.uri,
        title: embedObj.external.title || "",
        description: embedObj.external.description || "",
        thumb: embedObj.external.thumb || null,
      };
    } else if (type === "app.bsky.embed.record#view" || type === "app.bsky.embed.recordWithMedia#view") {
      const recordView = type === "app.bsky.embed.recordWithMedia#view" ? embedObj.record?.record : embedObj.record;
      if (recordView && recordView.$type === "app.bsky.embed.record#viewRecord") {
        const recHandle = recordView.author?.handle;
        const recRkey = (recordView.uri as string).split("/").pop();
        embed = {
          type: "quote",
          uri: recordView.uri,
          author: recordView.author?.displayName || recHandle || "",
          authorHandle: recHandle ? "@" + recHandle : "",
          avatar: recordView.author?.avatar || "",
          content: recordView.value?.text || "",
          createdAt: recordView.value?.createdAt || recordView.indexedAt || "",
          url: recHandle ? `https://bsky.app/profile/${recHandle}/post/${recRkey}` : "",
        };
      }
    }
  }
  return { media, embed };
}

/**
 * Fetch @-mentions, replies and quotes from the account's notifications so they
 * show in the unified Mentions inbox with inline media and quoted posts.
 */
export async function fetchBlueskyMentions(limit = 40): Promise<NormalizedMention[]> {
  await ensureFreshToken();
  const session = loadSession();
  const result = await xrpc(session, "app.bsky.notification.listNotifications", "GET", undefined, {
    limit: String(limit),
  });
  const notifs = (result?.notifications ?? []).filter((n: any) =>
    ["mention", "reply", "quote"].includes(n.reason) &&
    // Never surface our own replies/mentions to our own threads in the inbox.
    n.author?.did !== session.did,
  );
  if (!notifs.length) return [];

  // Hydrate the notifying posts (getPosts handles up to 25 URIs) so we get
  // media/quote views and author handles/avatars, not just the raw record.
  const uris = [...new Set(notifs.map((n: any) => n.uri as string))].slice(0, 25);
  const views: Record<string, any> = {};
  try {
    const got = await xrpc(session, "app.bsky.feed.getPosts", "GET", undefined, { uris: uris.join(",") });
    for (const p of got?.posts ?? []) views[p.uri] = p;
  } catch (e) {
    console.warn("[bluesky] getPosts hydration failed:", (e as Error).message);
  }

  const out: NormalizedMention[] = [];
  for (const n of notifs) {
    const view = views[n.uri];
    const author = view?.author ?? n.author;
    const handle = author?.handle;
    const rkey = (n.uri as string).split("/").pop();
    const record = view?.record ?? n.record ?? {};
    const { media, embed } = view ? normalizeBlueskyPostView(view) : { media: [], embed: null };
    out.push({
      platform: "bluesky",
      remoteId: n.uri,
      remoteCid: n.cid,
      rootId: record.reply?.root?.uri || n.uri,
      rootCid: record.reply?.root?.cid || n.cid,
      reason: n.reason,
      author: author?.displayName || handle || "",
      authorHandle: handle ? "@" + handle : "",
      authorUrl: handle ? `https://bsky.app/profile/${handle}` : null,
      avatar: author?.avatar ?? null,
      content: record.text || "",
      url: handle ? `https://bsky.app/profile/${handle}/post/${rkey}` : null,
      published: record.createdAt || n.indexedAt || null,
      media,
      embed,
    });
  }
  return out;
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
  });
  const post = result?.thread?.post;
  const root = post ? { uri: post.uri, cid: post.cid } : null;
  // Drop replies we authored ourselves — replying to our own post from our own
  // account should never land in the Mentions inbox.
  const replies = (result?.thread?.replies ?? []).filter(
    (r: any) => r?.post?.author?.did !== session.did,
  );
  return { root, replies };
}
