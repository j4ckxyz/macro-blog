import { base64url } from "./indieauth.ts";

/**
 * DPoP (RFC 9449) helpers for ATProto OAuth. Uses P-256 / ES256 via WebCrypto.
 * Keys are stored as JWKs in the oauth_tokens.extra_json column.
 */

export interface DpopKeypair {
  privateJwk: JsonWebKey;
  publicJwk: JsonWebKey;
}

export async function generateDpopKeypair(): Promise<DpopKeypair> {
  const pair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const privateJwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  const publicJwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  // Public JWK for the DPoP header: only the public components.
  const pub: JsonWebKey = { kty: publicJwk.kty, crv: publicJwk.crv, x: publicJwk.x, y: publicJwk.y };
  return { privateJwk, publicJwk: pub };
}

async function importSigningKey(jwk: JsonWebKey): Promise<CryptoKey> {
  return crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
}

function b64urlJson(obj: unknown): string {
  return base64url(new TextEncoder().encode(JSON.stringify(obj)));
}

async function sha256b64url(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return base64url(digest);
}

export interface DpopProofInput {
  method: string;
  url: string;
  nonce?: string;
  accessToken?: string;
  keys: DpopKeypair;
}

/** Build a signed DPoP proof JWT for a single request. */
export async function createDpopProof(input: DpopProofInput): Promise<string> {
  const u = new URL(input.url);
  const htu = `${u.origin}${u.pathname}`;
  const header = {
    typ: "dpop+jwt",
    alg: "ES256",
    jwk: input.keys.publicJwk,
  };
  const payload: Record<string, unknown> = {
    jti: crypto.randomUUID(),
    htm: input.method.toUpperCase(),
    htu,
    iat: Math.floor(Date.now() / 1000),
  };
  if (input.nonce) payload.nonce = input.nonce;
  if (input.accessToken) payload.ath = await sha256b64url(input.accessToken);

  const signingInput = `${b64urlJson(header)}.${b64urlJson(payload)}`;
  const key = await importSigningKey(input.keys.privateJwk);
  const sig = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${base64url(sig)}`;
}

export interface DpopFetchOptions extends RequestInit {
  keys: DpopKeypair;
  accessToken?: string;
  dpopNonce?: string;
}

/**
 * fetch() wrapper that attaches a DPoP proof and transparently retries once
 * when the server returns a `use_dpop_nonce` challenge.
 */
export async function dpopFetch(
  url: string,
  options: DpopFetchOptions,
): Promise<{ res: Response; nonce?: string }> {
  const { keys, accessToken, dpopNonce, ...init } = options;
  const method = (init.method ?? "GET").toUpperCase();

  const doFetch = async (nonce?: string): Promise<Response> => {
    const proof = await createDpopProof({ method, url, nonce, accessToken, keys });
    const headers = new Headers(init.headers);
    headers.set("DPoP", proof);
    if (accessToken) headers.set("Authorization", `DPoP ${accessToken}`);
    return fetch(url, { ...init, method, headers });
  };

  let res = await doFetch(dpopNonce);
  let serverNonce = res.headers.get("DPoP-Nonce") ?? undefined;

  if ((res.status === 401 || res.status === 400) && serverNonce) {
    // Retry once with the server-provided nonce.
    const cloned = res.clone();
    let needsRetry = true;
    try {
      const body = await cloned.json();
      needsRetry = body?.error === "use_dpop_nonce";
    } catch {
      needsRetry = true;
    }
    if (needsRetry) {
      res = await doFetch(serverNonce);
      serverNonce = res.headers.get("DPoP-Nonce") ?? serverNonce;
    }
  }
  return { res, nonce: serverNonce };
}
