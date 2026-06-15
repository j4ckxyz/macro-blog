/**
 * Parse Micropub requests (both `application/x-www-form-urlencoded` and
 * `application/json`) into a normalised shape used by the content service.
 *
 * Spec: https://www.w3.org/TR/micropub/
 */

export type PostType = "post" | "article" | "photo" | "reply" | "bookmark" | "podcast";

export interface Photo {
  url: string;
  alt?: string;
  width?: number;
  height?: number;
}

export interface MicropubCreate {
  action: "create";
  type: PostType;
  content: string;
  name?: string;
  categories: string[];
  photos: Photo[];
  inReplyTo?: string;
  bookmarkOf?: string;
  published?: string; // ISO date
  status: "published" | "draft"; // post-status
  syndicateTo: string[]; // mp-syndicate-to uids
  slug?: string; // mp-slug
  // raw mf2 properties for forwarding extra fields
  properties: Record<string, any[]>;
}

export interface MicropubUpdate {
  action: "update";
  url: string;
  replace: Record<string, any[]>;
  add: Record<string, any[]>;
  delete: string[] | Record<string, any[]>;
}

export interface MicropubDelete {
  action: "delete";
  url: string;
}

export type MicropubRequest = MicropubCreate | MicropubUpdate | MicropubDelete;

function firstString(v: any): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (Array.isArray(v)) return firstString(v[0]);
  if (typeof v === "object" && "value" in v) return String(v.value);
  return String(v);
}

function asArray(v: any): any[] {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

function normalizePhotos(raw: any): Photo[] {
  return asArray(raw).map((p) => {
    if (typeof p === "string") return { url: p };
    if (p && typeof p === "object") {
      return { url: p.value ?? p.url ?? "", alt: p.alt };
    }
    return { url: String(p) };
  }).filter((p) => p.url);
}

function determineType(props: Record<string, any[]>): PostType {
  const name = firstString(props["name"]);
  const content = firstString(props["content"]) ?? "";
  if (props["bookmark-of"] && firstString(props["bookmark-of"])) return "bookmark";
  if (props["in-reply-to"] && firstString(props["in-reply-to"])) return "reply";
  if (props["photo"] && normalizePhotos(props["photo"]).length) return "photo";
  if (name && name.trim() && content.length > 280) return "article";
  if (name && name.trim()) return "article";
  return "post";
}

/** Extract plain text content from an mf2 content property (string or {html}). */
function extractContent(raw: any): string {
  const v = Array.isArray(raw) ? raw[0] : raw;
  if (v === undefined || v === null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "object") {
    if ("html" in v) return String(v.html);
    if ("value" in v) return String(v.value);
  }
  return String(v);
}

/** Build the normalised create object from mf2 properties. */
function buildCreate(props: Record<string, any[]>): MicropubCreate {
  const type = determineType(props);
  const statusRaw = firstString(props["post-status"]);
  const status = statusRaw === "draft" ? "draft" : "published";
  return {
    action: "create",
    type,
    content: extractContent(props["content"]),
    name: firstString(props["name"]),
    categories: asArray(props["category"]).map((c) => firstString(c)!).filter(Boolean),
    photos: normalizePhotos(props["photo"]),
    inReplyTo: firstString(props["in-reply-to"]),
    bookmarkOf: firstString(props["bookmark-of"]),
    published: firstString(props["published"]),
    status,
    syndicateTo: asArray(props["mp-syndicate-to"]).map((s) => firstString(s)!).filter(Boolean),
    slug: firstString(props["mp-slug"]),
    properties: props,
  };
}

/** Parse a JSON Micropub body. */
export function parseJson(body: any): MicropubRequest {
  if (body && body.action === "delete") {
    return { action: "delete", url: String(body.url) };
  }
  if (body && body.action === "update") {
    return {
      action: "update",
      url: String(body.url),
      replace: body.replace ?? {},
      add: body.add ?? {},
      delete: body.delete ?? [],
    };
  }
  const props: Record<string, any[]> = {};
  const src = body.properties ?? {};
  for (const key of Object.keys(src)) {
    props[key] = asArray(src[key]);
  }
  return buildCreate(props);
}

/** Parse a form-encoded Micropub body (URLSearchParams or FormData entries). */
export function parseForm(params: URLSearchParams): MicropubRequest {
  const action = params.get("action");
  if (action === "delete") {
    return { action: "delete", url: params.get("url") ?? "" };
  }
  if (action === "update") {
    // form-encoded updates are rare; support replace[key] style minimally
    return { action: "update", url: params.get("url") ?? "", replace: {}, add: {}, delete: [] };
  }

  const props: Record<string, any[]> = {};
  for (const [rawKey, value] of params.entries()) {
    if (rawKey === "h" || rawKey === "access_token") continue;
    const key = rawKey.replace(/\[\]$/, "");
    if (!props[key]) props[key] = [];
    props[key].push(value);
  }
  return buildCreate(props);
}

/** Parse a FormData object (multipart) into the create shape. */
export function parseFormData(form: FormData): MicropubRequest {
  const params = new URLSearchParams();
  for (const [key, value] of form.entries()) {
    if (typeof value === "string") params.append(key, value);
  }
  return parseForm(params);
}
