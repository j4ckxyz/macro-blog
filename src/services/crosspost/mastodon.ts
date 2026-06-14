import { getConfig } from "../../lib/config.ts";
import { getToken } from "../../lib/tokens.ts";
import type { CrosspostPayload, CrosspostResult } from "./types.ts";

/**
 * Mastodon (and GoToSocial) cross-posting. Uses only stable v1 endpoints
 * and prefers text/plain so GoToSocial instances behave consistently.
 */

function instanceUrl(): string {
  const cfg = getConfig();
  const url = cfg.crossposting.mastodon.instance_url;
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
  const cfg = getConfig();
  if (payload.type === "article" && payload.title) {
    const excerpt = payload.text.slice(0, 280).trim();
    return `${payload.title}\n\n${excerpt ? excerpt + "\n\n" : ""}${payload.url}`;
  }
  if (payload.type === "bookmark") {
    return `${payload.text}\n\n${payload.url}`.trim();
  }
  // Short note: post the text; Mastodon allows long posts so no truncation.
  return payload.text.trim() || payload.url;
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

  const body: Record<string, unknown> = {
    status: buildStatus(payload),
    visibility: "public",
    language: cfg.site.language || "en",
  };
  if (mediaIds.length) body.media_ids = mediaIds;

  const res = await fetchImpl(`${base}/api/v1/statuses`, {
    method: "POST",
    headers: {
      Authorization: authHeader(),
      "content-type": "application/json",
      "Idempotency-Key": payload.url,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`mastodon post failed: ${res.status} ${await res.text()}`);
  }
  const json = (await res.json()) as { id: string; url: string; uri: string };
  return { remoteId: json.id, remoteUrl: json.url || json.uri };
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
