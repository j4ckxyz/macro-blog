import { Hono } from "hono";
import { getConfig } from "../../lib/config.ts";
import { verifyPassword, issueToken } from "../../lib/indieauth.ts";

/**
 * Lightweight password login for the built-in admin UI. Exchanges the
 * configured password for a full-scope IndieAuth bearer token. (Third-party
 * Micropub clients should use the proper IndieAuth flow instead.)
 */
export const adminLogin = new Hono();

adminLogin.post("/", async (c) => {
  const cfg = getConfig();
  const body = await c.req.json().catch(() => ({}));
  const password = (body as any).password ?? "";
  const ok = await verifyPassword(password, cfg.auth.password_hash);
  if (!ok) return c.json({ error: "invalid_password" }, 401);

  const me = cfg.site.url.replace(/\/+$/, "/");
  const token = issueToken({ clientId: `${me}admin/`, scope: "create update delete media", me });
  return c.json({ access_token: token, token_type: "Bearer", scope: "create update delete media", me });
});
