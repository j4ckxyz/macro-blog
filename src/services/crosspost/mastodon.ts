import { getConfig } from "../../lib/config.ts";
import { getToken, getTokenExtra, setReauth } from "../../lib/tokens.ts";
import type { CrosspostPayload, CrosspostResult, NormalizedMention } from "./types.ts";
import type { NormalizedTimelineItem } from "../timeline.ts";
import { splitPostIntoThread, formatChunkForMastodon } from "./thread.ts";

/** Mark/clear reauth based on an API response status. */
function checkAuth(status: number): void {
  if (status === 401 || status === 403) setReauth("mastodon", true);
  else setReauth("mastodon", false);
}

/**
 * Mastodon (and GoToSocial) cross-posting. Uses only stable v1 endpoints
 * and prefers text/plain so GoToSocial instances behave consistently.
 */

function instanceUrl(): string {
  // Prefer the instance we actually hold a token for, so we always talk to the
  // currently-connected account — never a stale config value left over from a
  // previously authenticated account.
  const url = getTokenExtra("mastodon").instance || getConfig().crossposting.mastodon.instance_url;
  if (!url) throw new Error("mastodon instance_url not configured");
  return url.replace(/\/+$/, "");
}

function authHeader(): string {
  const token = getToken("mastodon");
  if (!token?.access_token) throw new Error("mastodon not connected");
  return `Bearer ${token.access_token}`;
}

/** Build the status text for a post depending on its type. */
export function buildStatus(payload: CrosspostPayload): string {
  const linkBack = payload.linkBack === true;
  if (payload.type === "article" && payload.title) {
    const excerpt = payload.text.slice(0, 280).trim();
    return `${payload.title}\n\n${excerpt ? excerpt + "\n\n" : ""}${payload.url}`;
  }
  if (payload.type === "bookmark") {
    return `${payload.text}\n\n${payload.url}`.trim();
  }
  // Short note: post the text; Mastodon allows long posts so no truncation.
  let status = payload.text.trim();
  if (linkBack) {
    status = `${status}\n\n${payload.url}`.trim();
  }
  return status || payload.url;
}

/** Turn category names into Mastodon hashtag tokens (#CamelCase, no spaces). */
export function categoriesToHashtags(categories: string[] | undefined): string[] {
  if (!categories?.length) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of categories) {
    const tag = String(raw).replace(/^#+/, "").replace(/\s+/g, "").trim();
    if (!tag) continue;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push("#" + tag);
  }
  return out;
}

/**
 * Append category hashtags to the end of a status, skipping any already present
 * in the text (case-insensitive) and only if they fit within `limit`.
 */
export function appendHashtags(text: string, categories: string[] | undefined, limit = 500): string {
  const tags = categoriesToHashtags(categories);
  if (!tags.length) return text;
  const lower = text.toLowerCase();
  const toAdd = tags.filter((t) => !lower.includes(t.toLowerCase()));
  if (!toAdd.length) return text;
  const suffix = "\n\n" + toAdd.join(" ");
  if ([...(text + suffix)].length > limit) return text; // no room — skip silently
  return text + suffix;
}

async function uploadMedia(photo: { url: string; alt?: string }): Promise<string> {
  const base = instanceUrl();
  const fileRes = await fetch(photo.url);
  if (!fileRes.ok) throw new Error(`failed to fetch media ${photo.url}`);
  const blob = await fileRes.blob();
  const form = new FormData();
  form.set("file", blob, photo.url.split("/").pop() || "image");
  if (photo.alt) form.set("description", photo.alt);
  // v1 media endpoint works on both Mastodon and GoToSocial.
  const res = await fetch(`${base}/api/v1/media`, {
    method: "POST",
    headers: { Authorization: authHeader() },
    body: form,
  });
  if (!res.ok) throw new Error(`mastodon media upload failed: ${res.status} ${await res.text()}`);
  const json = (await res.json()) as { id: string };
  return json.id;
}

export async function crosspostMastodon(
  payload: CrosspostPayload,
  fetchImpl: typeof fetch = fetch,
): Promise<CrosspostResult> {
  const cfg = getConfig();
  const base = instanceUrl();

  const mediaIds: string[] = [];
  for (const photo of payload.photos) {
    mediaIds.push(await uploadMedia(photo));
  }

  let chunks: string[] = [buildStatus(payload)];
  if (payload.type === "post") {
    const limit = 480;
    const bodyText = payload.markdown || payload.text;
    const threadParts = splitPostIntoThread(bodyText, limit, payload.url, payload.linkBack === true);
    chunks = threadParts.map(formatChunkForMastodon);
  }

  // Append category hashtags to the final status (if they fit and aren't
  // already in the text). Body #hashtags already render as tags on Mastodon.
  if (payload.categories?.length && chunks.length) {
    const last = chunks.length - 1;
    chunks[last] = appendHashtags(chunks[last], payload.categories, 500);
  }

  let parentId: string | undefined = undefined;
  let firstUrl = "";
  let firstId = "";

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const body: Record<string, unknown> = {
      status: chunk,
      visibility: "public",
      language: cfg.site.language || "en",
    };
    if (i === 0 && mediaIds.length) {
      body.media_ids = mediaIds;
    }
    if (parentId) {
      body.in_reply_to_id = parentId;
    }

    const res = await fetchImpl(`${base}/api/v1/statuses`, {
      method: "POST",
      headers: {
        Authorization: authHeader(),
        "content-type": "application/json",
        "Idempotency-Key": i === 0 ? payload.url : `${payload.url}-${i}`,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      checkAuth(res.status);
      throw new Error(`mastodon post failed at part ${i + 1}/${chunks.length}: ${res.status} ${await res.text()}`);
    }
    checkAuth(res.status);
    const json = (await res.json()) as { id: string; url: string; uri: string };
    parentId = json.id;
    if (i === 0) {
      firstId = json.id;
      firstUrl = json.url || json.uri;
    }
  }

  return { remoteId: firstId, remoteUrl: firstUrl };
}

function stripHtml(html: string): string {
  return html.replace(/<br\s*\/?>(\n)?/gi, "\n").replace(/<\/p>/gi, "\n\n").replace(/<[^>]+>/g, "").trim();
}

/** Fetch the authenticated user's home (following) timeline. */
export async function fetchMastodonHomeTimeline(limit = 40): Promise<NormalizedTimelineItem[]> {
  const base = instanceUrl();
  const res = await fetch(`${base}/api/v1/timelines/home?limit=${limit}`, {
    headers: { Authorization: authHeader() },
  });
  if (!res.ok) {
    checkAuth(res.status);
    throw new Error(`mastodon timeline failed: ${res.status}`);
  }
  checkAuth(res.status);
  const statuses = (await res.json()) as any[];
  return statuses.map((s) => {
    const reblog = s.reblog;
    const post = reblog || s;
    const isReply = post.in_reply_to_id != null;
    let embed: any = null;
    if (post.card && post.card.url) {
      embed = {
        type: "link",
        uri: post.card.url,
        title: post.card.title || "",
        description: post.card.description || "",
        thumb: post.card.image || null,
      };
    }

    return {
      platform: "mastodon" as const,
      remoteId: s.id,
      author: post.account?.display_name || post.account?.username || "",
      authorHandle: post.account?.acct ? "@" + post.account.acct : "",
      avatar: post.account?.avatar || "",
      content: stripHtml(post.content || ""),
      url: post.url || post.uri || "",
      media: (post.media_attachments || []).map((m: any) => ({ url: m.url, alt: m.description || "" })),
      repostedBy: reblog ? s.account?.display_name || s.account?.username : null,
      createdAt: post.created_at || new Date().toISOString(),
      isReply,
      embed,
    };
  });
}

/** Post a reply to a Mastodon status (used by the unified Mentions tab). */
export async function replyMastodon(
  inReplyToId: string,
  text: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ id: string; url: string }> {
  const cfg = getConfig();
  const base = instanceUrl();
  const res = await fetchImpl(`${base}/api/v1/statuses`, {
    method: "POST",
    headers: { Authorization: authHeader(), "content-type": "application/json" },
    body: JSON.stringify({
      status: text,
      in_reply_to_id: inReplyToId,
      visibility: "public",
      language: cfg.site.language || "en",
    }),
  });
  if (!res.ok) throw new Error(`mastodon reply failed: ${res.status} ${await res.text()}`);
  const json = (await res.json()) as { id: string; url: string };
  return { id: json.id, url: json.url };
}

/**
 * Fetch @-mentions (and reply notifications) from the Mastodon home account so
 * they appear in the unified Mentions inbox — independent of whether they
 * reply to a syndicated post.
 */
export async function fetchMastodonMentions(limit = 40): Promise<NormalizedMention[]> {
  const base = instanceUrl();
  const res = await fetch(`${base}/api/v1/notifications?types[]=mention&limit=${limit}`, {
    headers: { Authorization: authHeader() },
  });
  if (!res.ok) {
    checkAuth(res.status);
    throw new Error(`mastodon mentions failed: ${res.status}`);
  }
  checkAuth(res.status);
  const notifs = (await res.json()) as any[];
  const out: NormalizedMention[] = [];
  for (const n of notifs) {
    const s = n.status;
    if (!s) continue;
    out.push({
      platform: "mastodon",
      remoteId: s.id,
      reason: s.in_reply_to_id ? "reply" : "mention",
      author: s.account?.display_name || s.account?.username || "",
      authorHandle: s.account?.acct ? "@" + s.account.acct : "",
      authorUrl: s.account?.url ?? null,
      avatar: s.account?.avatar ?? null,
      content: stripHtml(s.content || ""),
      url: s.url || s.uri || null,
      published: s.created_at || n.created_at || null,
      media: (s.media_attachments || []).map((m: any) => ({
        url: m.url,
        alt: m.description || "",
        type: m.type || "image",
      })),
      embed: s.card && s.card.url
        ? { type: "link", uri: s.card.url, title: s.card.title || "", description: s.card.description || "", thumb: s.card.image || null }
        : null,
    });
  }
  return out;
}

/**
 * Post a (possibly multi-part) reply thread to a Mastodon status. Each chunk
 * replies to the previous one. Returns the first status's id/url.
 */
export async function replyMastodonThread(
  inReplyToId: string,
  texts: string[],
  fetchImpl: typeof fetch = fetch,
): Promise<{ id: string; url: string }> {
  const cfg = getConfig();
  const base = instanceUrl();
  let parentId = inReplyToId;
  let firstId = "";
  let firstUrl = "";
  for (let i = 0; i < texts.length; i++) {
    const res = await fetchImpl(`${base}/api/v1/statuses`, {
      method: "POST",
      headers: { Authorization: authHeader(), "content-type": "application/json" },
      body: JSON.stringify({
        status: texts[i],
        in_reply_to_id: parentId,
        visibility: "public",
        language: cfg.site.language || "en",
      }),
    });
    if (!res.ok) throw new Error(`mastodon reply failed at part ${i + 1}: ${res.status} ${await res.text()}`);
    const json = (await res.json()) as { id: string; url: string };
    parentId = json.id;
    if (i === 0) {
      firstId = json.id;
      firstUrl = json.url;
    }
  }
  return { id: firstId, url: firstUrl };
}

/** Fetch replies to a syndicated status via the context endpoint. */
export async function fetchMastodonReplies(statusId: string): Promise<any[]> {
  const base = instanceUrl();
  const res = await fetch(`${base}/api/v1/statuses/${statusId}/context`, {
    headers: { Authorization: authHeader() },
  });
  if (!res.ok) return [];
  const json = (await res.json()) as { descendants?: any[] };
  return json.descendants ?? [];
}
