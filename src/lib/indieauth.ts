import type { Database } from "bun:sqlite";
import { getDb } from "../db/index.ts";
import type { IndieauthTokenRow, IndieauthSessionRow } from "../db/schema.ts";

/** Random URL-safe token. */
export function randomToken(bytes = 32): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return base64url(buf);
}

export function base64url(buf: Uint8Array | ArrayBuffer): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let str = "";
  for (const b of bytes) str += String.fromCharCode(b);
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Compute the S256 PKCE challenge for a verifier. */
export async function s256Challenge(verifier: string): Promise<string> {
  const data = new TextEncoder().encode(verifier);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return base64url(digest);
}

/**
 * Verify a PKCE code_verifier against a stored challenge.
 * Supports S256 and `plain`. If no challenge was stored, succeeds
 * (clients that don't use PKCE).
 */
export async function verifyPkce(
  verifier: string | undefined,
  challenge: string | null,
  method: string | null,
): Promise<boolean> {
  if (!challenge) return true; // PKCE optional when no challenge issued
  if (!verifier) return false;
  if (!method || method.toUpperCase() === "S256") {
    return (await s256Challenge(verifier)) === challenge;
  }
  if (method.toLowerCase() === "plain") {
    return verifier === challenge;
  }
  return false;
}

export interface NewAuthCode {
  code: string;
  clientId: string;
  redirectUri: string;
  scope: string;
  codeChallenge?: string;
  codeChallengeMethod?: string;
  ttlSeconds?: number;
}

export function storeAuthCode(input: NewAuthCode, db: Database = getDb()): string {
  const expires = new Date(Date.now() + (input.ttlSeconds ?? 600) * 1000).toISOString();
  db.query(
    `INSERT INTO indieauth_sessions
      (code, code_challenge, code_challenge_method, client_id, redirect_uri, scope, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.code,
    input.codeChallenge ?? null,
    input.codeChallengeMethod ?? null,
    input.clientId,
    input.redirectUri,
    input.scope,
    expires,
  );
  return input.code;
}

export function getAuthCode(code: string, db: Database = getDb()): IndieauthSessionRow | null {
  return db
    .query("SELECT * FROM indieauth_sessions WHERE code = ?")
    .get(code) as IndieauthSessionRow | null;
}

export function consumeAuthCode(code: string, db: Database = getDb()): void {
  db.query("UPDATE indieauth_sessions SET used = 1 WHERE code = ?").run(code);
}

export function isAuthCodeValid(row: IndieauthSessionRow | null): boolean {
  if (!row) return false;
  if (row.used) return false;
  if (new Date(row.expires_at).getTime() < Date.now()) return false;
  return true;
}

export interface NewToken {
  clientId: string;
  scope: string;
  me: string;
}

export function issueToken(input: NewToken, db: Database = getDb()): string {
  const token = randomToken(32);
  db.query(
    "INSERT INTO indieauth_tokens (token, client_id, scope, me) VALUES (?, ?, ?, ?)",
  ).run(token, input.clientId, input.scope, input.me);
  return token;
}

export function verifyToken(token: string, db: Database = getDb()): IndieauthTokenRow | null {
  if (!token) return null;
  const row = db
    .query("SELECT * FROM indieauth_tokens WHERE token = ? AND revoked = 0")
    .get(token) as IndieauthTokenRow | null;
  return row;
}

export function revokeToken(token: string, db: Database = getDb()): void {
  db.query("UPDATE indieauth_tokens SET revoked = 1 WHERE token = ?").run(token);
}

/** Extract a bearer token from an Authorization header or form/body field. */
export function extractBearer(headerValue: string | null | undefined): string | null {
  if (!headerValue) return null;
  const m = headerValue.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

export function hasScope(scope: string | null | undefined, required: string): boolean {
  if (!scope) return false;
  const scopes = scope.split(/\s+/).filter(Boolean);
  // Micropub clients sometimes use "post" as an alias for "create".
  if (required === "create" && (scopes.includes("post") || scopes.includes("create"))) return true;
  return scopes.includes(required);
}

/** Password hashing/verification via Bun's built-in argon2/bcrypt. */
export async function hashPassword(password: string): Promise<string> {
  return await Bun.password.hash(password);
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  if (!hash) return false;
  try {
    return await Bun.password.verify(password, hash);
  } catch {
    return false;
  }
}
