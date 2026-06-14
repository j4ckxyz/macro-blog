import { Hono } from "hono";
import { getConfig } from "../lib/config.ts";

export const wellknown = new Hono();

function siteHost(): string {
  return new URL(getConfig().site.url).hostname;
}

// WebFinger — lets Mastodon/Micro.blog look up the blog as a social identity.
wellknown.get("/webfinger", (c) => {
  const cfg = getConfig();
  const resource = c.req.query("resource") ?? "";
  const host = siteHost();
  const acct = `acct:${cfg.site.username}@${host}`;
  const site = cfg.site.url.replace(/\/+$/, "/");

  // Accept acct:user@host or the site URL itself.
  const matchesAcct = resource === acct || resource === `acct:${host}`;
  const matchesUrl = resource === site || resource === cfg.site.url || resource === `https://${host}` || resource === `http://${host}`;
  if (resource && !matchesAcct && !matchesUrl) {
    return c.json({ error: "not_found" }, 404);
  }

  return c.json(
    {
      subject: matchesUrl ? site : acct,
      aliases: [site, acct],
      links: [
        { rel: "self", type: "text/html", href: site },
        { rel: "http://webmention.org/", href: `${site}webmention` },
        { rel: "micropub", href: `${site}micropub` },
      ],
    },
    200,
    { "content-type": "application/jrd+json" },
  );
});

// host-meta — XRD pointing at the webfinger endpoint.
wellknown.get("/host-meta", (c) => {
  const site = getConfig().site.url.replace(/\/+$/, "/");
  const xrd = `<?xml version="1.0" encoding="UTF-8"?>
<XRD xmlns="http://docs.oasis-open.org/ns/xri/xrd-1.0">
  <Link rel="lrdd" type="application/jrd+json" template="${site}.well-known/webfinger?resource={uri}" />
</XRD>`;
  return c.body(xrd, 200, { "content-type": "application/xrd+xml" });
});

// NodeInfo discovery + 2.1 document describing this as "blog" software.
wellknown.get("/nodeinfo", (c) => {
  const site = getConfig().site.url.replace(/\/+$/, "/");
  return c.json({
    links: [
      { rel: "http://nodeinfo.diaspora.software/ns/schema/2.1", href: `${site}.well-known/nodeinfo/2.1` },
    ],
  });
});

wellknown.get("/nodeinfo/2.1", (c) => {
  const cfg = getConfig();
  return c.json({
    version: "2.1",
    software: { name: "macroblog", version: "0.1.0", repository: "https://github.com/j4ckxyz/macro-blog" },
    protocols: [],
    services: { inbound: [], outbound: ["rss2.0", "atom1.0"] },
    openRegistrations: false,
    usage: { users: { total: 1 } },
    metadata: { nodeName: cfg.site.title, nodeDescription: cfg.site.description },
  });
});
