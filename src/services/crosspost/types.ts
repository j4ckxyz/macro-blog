import type { PostType } from "../../lib/micropub-parser.ts";

export interface CrosspostPhoto {
  url: string; // absolute URL
  alt?: string;
  width?: number;
  height?: number;
}

export interface CrosspostPayload {
  text: string; // plain-text content (markdown stripped)
  markdown?: string; // original markdown content
  url: string; // canonical permalink
  title?: string;
  type: PostType;
  photos: CrosspostPhoto[];
  inReplyTo?: string;
  linkBack?: boolean;
  lang?: string;
  /** Post categories → hidden Bluesky tags + appended Mastodon hashtags. */
  categories?: string[];
}

export interface CrosspostResult {
  remoteId: string;
  remoteUrl: string;
}

/** A normalized @-mention / reply / quote pulled from a social platform. */
export interface NormalizedMention {
  platform: "mastodon" | "bluesky";
  remoteId: string;
  remoteCid?: string | null;
  rootId?: string | null;
  rootCid?: string | null;
  reason: "mention" | "reply" | "quote";
  author: string;
  authorHandle: string;
  authorUrl?: string | null;
  avatar?: string | null;
  content: string;
  url?: string | null;
  published?: string | null;
  media: { url: string; alt?: string; type?: string }[];
  embed?: any | null;
}
