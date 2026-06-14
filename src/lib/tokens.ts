import type { Database } from "bun:sqlite";
import { getDb } from "../db/index.ts";
import type { OAuthTokenRow } from "../db/schema.ts";

export interface TokenData {
  access_token?: string | null;
  refresh_token?: string | null;
  token_type?: string | null;
  expires_at?: string | null;
  scope?: string | null;
  extra?: Record<string, any> | null;
}

export function getToken(platform: string, db: Database = getDb()): OAuthTokenRow | null {
  return db.query("SELECT * FROM oauth_tokens WHERE platform = ?").get(platform) as OAuthTokenRow | null;
}

export function getTokenExtra(platform: string, db: Database = getDb()): Record<string, any> {
  const row = getToken(platform, db);
  if (!row?.extra_json) return {};
  try {
    return JSON.parse(row.extra_json);
  } catch {
    return {};
  }
}

/** Upsert OAuth token data for a platform. */
export function saveToken(platform: string, data: TokenData, db: Database = getDb()): void {
  const extraJson = data.extra ? JSON.stringify(data.extra) : null;
  const existing = getToken(platform, db);
  if (existing) {
    db.query(
      `UPDATE oauth_tokens SET
        access_token = COALESCE(?, access_token),
        refresh_token = COALESCE(?, refresh_token),
        token_type = COALESCE(?, token_type),
        expires_at = COALESCE(?, expires_at),
        scope = COALESCE(?, scope),
        extra_json = COALESCE(?, extra_json),
        updated_at = CURRENT_TIMESTAMP
       WHERE platform = ?`,
    ).run(
      data.access_token ?? null,
      data.refresh_token ?? null,
      data.token_type ?? null,
      data.expires_at ?? null,
      data.scope ?? null,
      extraJson,
      platform,
    );
  } else {
    db.query(
      `INSERT INTO oauth_tokens (platform, access_token, refresh_token, token_type, expires_at, scope, extra_json)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      platform,
      data.access_token ?? null,
      data.refresh_token ?? null,
      data.token_type ?? null,
      data.expires_at ?? null,
      data.scope ?? null,
      extraJson,
    );
  }
}

export function deleteToken(platform: string, db: Database = getDb()): void {
  db.query("DELETE FROM oauth_tokens WHERE platform = ?").run(platform);
}

export function isConnected(platform: string, db: Database = getDb()): boolean {
  const row = getToken(platform, db);
  return !!row?.access_token;
}
