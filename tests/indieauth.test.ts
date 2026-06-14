import { test, expect, describe, beforeEach } from "bun:test";
import { freshDb } from "./helpers.ts";
import { app } from "../src/app.ts";
import { s256Challenge, base64url, verifyToken } from "../src/lib/indieauth.ts";

beforeEach(() => freshDb());

async function getAuthCode(verifier: string, scope = "create update") {
  const challenge = await s256Challenge(verifier);
  const res = await app.request("/indieauth/auth", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      password: process.env.TEST_PASSWORD!,
      client_id: "https://client.example/",
      redirect_uri: "https://client.example/callback",
      state: "abc",
      scope,
      code_challenge: challenge,
      code_challenge_method: "S256",
    }).toString(),
    redirect: "manual",
  });
  expect(res.status).toBe(302);
  const loc = new URL(res.headers.get("location")!);
  return loc.searchParams.get("code")!;
}

describe("IndieAuth", () => {
  test("auth code + PKCE flow issues a token", async () => {
    const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
    const code = await getAuthCode(verifier);
    expect(code).toBeTruthy();

    const res = await app.request("/indieauth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        client_id: "https://client.example/",
        redirect_uri: "https://client.example/callback",
        code_verifier: verifier,
      }).toString(),
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.access_token).toBeTruthy();
    expect(json.token_type).toBe("Bearer");
    expect(json.me).toBe("http://127.0.0.1:3000/");
    expect(json.scope).toBe("create update");
    expect(verifyToken(json.access_token)).toBeTruthy();
  });

  test("wrong password is rejected", async () => {
    const res = await app.request("/indieauth/auth", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        password: "wrong",
        client_id: "https://client.example/",
        redirect_uri: "https://client.example/callback",
        scope: "create",
      }).toString(),
    });
    expect(res.status).toBe(401);
  });

  test("a used code cannot be reused", async () => {
    const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
    const code = await getAuthCode(verifier);
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: "https://client.example/",
      redirect_uri: "https://client.example/callback",
      code_verifier: verifier,
    }).toString();
    const headers = { "content-type": "application/x-www-form-urlencoded" };

    const first = await app.request("/indieauth/token", { method: "POST", headers, body });
    expect(first.status).toBe(200);
    const second = await app.request("/indieauth/token", { method: "POST", headers, body });
    expect(second.status).toBe(400);
  });

  test("invalid code returns 400", async () => {
    const res = await app.request("/indieauth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", code: "nope" }).toString(),
    });
    expect(res.status).toBe(400);
  });

  test("PKCE mismatch is rejected", async () => {
    const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
    const code = await getAuthCode(verifier);
    const res = await app.request("/indieauth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        client_id: "https://client.example/",
        redirect_uri: "https://client.example/callback",
        code_verifier: "the-wrong-verifier",
      }).toString(),
    });
    expect(res.status).toBe(400);
  });
});
