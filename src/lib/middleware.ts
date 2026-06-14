import type { Context, Next } from "hono";
import { extractBearer, verifyToken, hasScope } from "./indieauth.ts";
import type { IndieauthTokenRow } from "../db/schema.ts";

declare module "hono" {
  interface ContextVariableMap {
    token: IndieauthTokenRow;
  }
}

async function resolveToken(c: Context): Promise<IndieauthTokenRow | null> {
  let bearer = extractBearer(c.req.header("authorization"));
  if (!bearer) {
    // Micropub permits the token in the form body as `access_token`.
    const ct = c.req.header("content-type") ?? "";
    if (ct.includes("form")) {
      try {
        const body = await c.req.parseBody();
        if (typeof body["access_token"] === "string") bearer = body["access_token"];
      } catch {
        /* ignore */
      }
    }
  }
  if (!bearer) return null;
  return verifyToken(bearer);
}

/** Require a valid bearer token, optionally with a specific scope. */
export function requireAuth(scope?: string) {
  return async (c: Context, next: Next) => {
    const token = await resolveToken(c);
    if (!token) {
      return c.json({ error: "unauthorized", error_description: "missing or invalid token" }, 401);
    }
    if (scope && !hasScope(token.scope, scope)) {
      return c.json(
        { error: "insufficient_scope", error_description: `requires scope: ${scope}`, scope },
        403,
      );
    }
    c.set("token", token);
    await next();
  };
}
