import type { PostType } from "../../lib/micropub-parser.ts";

export interface CrosspostPhoto {
  url: string; // absolute URL
  alt?: string;
  width?: number;
  height?: number;
}

export interface CrosspostPayload {
  text: string; // plain-text content (markdown stripped)
  url: string; // canonical permalink
  title?: string;
  type: PostType;
  photos: CrosspostPhoto[];
  inReplyTo?: string;
  linkBack?: boolean;
}

export interface CrosspostResult {
  remoteId: string;
  remoteUrl: string;
}
