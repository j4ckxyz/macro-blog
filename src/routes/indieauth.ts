import { Hono } from "hono";
import { getConfig, baseUrl } from "../lib/config.ts";
import {
  randomToken,
  storeAuthCode,
  getAuthCode,
  consumeAuthCode,
  isAuthCodeValid,
  verifyPkce,
  issueToken,
  verifyPassword,
} from "../lib/indieauth.ts";

export const indieauth = new Hono();

function loginPage(params: URLSearchParams, error?: string): string {
  const fields = ["client_id", "redirect_uri", "state", "response_type", "scope", "me", "code_challenge", "code_challenge_method"];
  const hidden = fields
    .map((f) => `<input type="hidden" name="${f}" value="${escapeHtml(params.get(f) ?? "")}" />`)
    .join("\n");
  const client = escapeHtml(params.get("client_id") ?? "an application");
  const scope = escapeHtml(params.get("scope") ?? "");
  return `<!DOCTYPE html><html><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Sign in — Macroblog</title>
<style>body{font-family:ui-monospace,monospace;max-width:28rem;margin:4rem auto;padding:0 1rem;color:#111}
input[type=password]{width:100%;padding:.6rem;font-size:1rem;border:1px solid #ccc;border-radius:6px}
button{margin-top:1rem;padding:.6rem 1.2rem;background:#111;color:#fff;border:0;border-radius:6px;cursor:pointer}
.err{color:#b00;margin:1rem 0}.scope{color:#666;font-size:.85rem}</style></head>
<body><h1>Sign in</h1>
<p><strong>${client}</strong> wants to access your site.</p>
${scope ? `<p class="scope">Requested scope: ${scope}</p>` : ""}
${error ? `<p class="err">${escapeHtml(error)}</p>` : ""}
<form method="post" action="/indieauth/auth">
${hidden}
<label>Password<br/><input type="password" name="password" autofocus required /></label>
<button type="submit">Authorize</button>
</form></body></html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

// GET — show login/consent form.
indieauth.get("/auth", (c) => {
  const url = new URL(c.req.url);
  return c.html(loginPage(url.searchParams));
});

// POST — either login form submission or authorization-code verification.
indieauth.post("/auth", async (c) => {
  const cfg = getConfig();
  const body = await c.req.parseBody();
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(body)) {
    if (typeof v === "string") params.set(k, v);
  }

  // Case 1: login form submission (password present).
  if (params.has("password")) {
    const ok = await verifyPassword(params.get("password")!, cfg.auth.password_hash);
    if (!ok) {
      params.delete("password");
      return c.html(loginPage(params, "Incorrect password."), 401);
    }
    const code = randomToken(24);
    const scope = params.get("scope") ?? "";
    storeAuthCode({
      code,
      clientId: params.get("client_id") ?? "",
      redirectUri: params.get("redirect_uri") ?? "",
      scope,
      codeChallenge: params.get("code_challenge") || undefined,
      codeChallengeMethod: params.get("code_challenge_method") || undefined,
    });
    const redirect = new URL(params.get("redirect_uri")!);
    redirect.searchParams.set("code", code);
    if (params.get("state")) redirect.searchParams.set("state", params.get("state")!);
    if (scope) redirect.searchParams.set("iss", baseUrl(cfg));
    return c.redirect(redirect.toString(), 302);
  }

  // Case 2: authorization-code verification (profile URL exchange, no token).
  return handleCodeExchange(c, params, false);
});

// POST /token — exchange auth code for a bearer token.
indieauth.post("/token", async (c) => {
  const body = await c.req.parseBody();
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(body)) {
    if (typeof v === "string") params.set(k, v);
  }
  return handleCodeExchange(c, params, true);
});

async function handleCodeExchange(c: any, params: URLSearchParams, issueBearer: boolean) {
  const cfg = getConfig();
  const code = params.get("code");
  if (!code) return c.json({ error: "invalid_request", error_description: "missing code" }, 400);

  const row = getAuthCode(code);
  if (!isAuthCodeValid(row)) {
    return c.json({ error: "invalid_grant", error_description: "code invalid, used, or expired" }, 400);
  }
  // Validate redirect_uri / client_id match when provided.
  const redirectUri = params.get("redirect_uri");
  if (redirectUri && row!.redirect_uri && redirectUri !== row!.redirect_uri) {
    return c.json({ error: "invalid_grant", error_description: "redirect_uri mismatch" }, 400);
  }
  const clientId = params.get("client_id");
  if (clientId && row!.client_id && clientId !== row!.client_id) {
    return c.json({ error: "invalid_grant", error_description: "client_id mismatch" }, 400);
  }

  const pkceOk = await verifyPkce(
    params.get("code_verifier") ?? undefined,
    row!.code_challenge,
    row!.code_challenge_method,
  );
  if (!pkceOk) {
    return c.json({ error: "invalid_grant", error_description: "PKCE verification failed" }, 400);
  }

  consumeAuthCode(code);
  const me = baseUrl(cfg);
  const scope = row!.scope ?? "";

  if (!issueBearer) {
    // Authorization endpoint: return profile URL only.
    return c.json({ me });
  }

  if (!scope) {
    // No scope means authentication only; the token endpoint requires a scope.
    return c.json({ error: "invalid_scope", error_description: "no scope requested" }, 400);
  }

  const token = issueToken({ clientId: row!.client_id, scope, me });
  return c.json({
    access_token: token,
    token_type: "Bearer",
    scope,
    me,
  });
}
