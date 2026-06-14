# Macroblog — single self-hosted container (Bun + Hugo).
# Multi-arch: builds for the host platform (amd64 / arm64) automatically.
FROM oven/bun:1 AS base

ARG TARGETARCH
ARG HUGO_VERSION=0.147.0

# Hugo extended (matched to the build architecture).
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl tar \
 && rm -rf /var/lib/apt/lists/* \
 && case "${TARGETARCH:-amd64}" in \
      arm64) H=arm64 ;; \
      amd64) H=amd64 ;; \
      *) echo "unsupported arch: ${TARGETARCH}" && exit 1 ;; \
    esac \
 && curl -fsSL "https://github.com/gohugoio/hugo/releases/download/v${HUGO_VERSION}/hugo_extended_${HUGO_VERSION}_linux-${H}.tar.gz" \
    | tar xz -C /usr/local/bin hugo \
 && hugo version

WORKDIR /app

# Install dependencies first for better layer caching.
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile || bun install

# App source.
COPY . .

# Data locations (mounted as volumes). Config/db/backups live in /data;
# uploads stay under /app/uploads so the hugo static symlink remains valid.
ENV MACROBLOG_CONFIG=/data/macroblog.config.yaml \
    MACROBLOG_DB=/data/macroblog.db \
    MACROBLOG_BACKUPS=/data/backups \
    MACROBLOG_HUGO_SITE=/app/hugo-site \
    MACROBLOG_PUBLIC=/app/public \
    MACROBLOG_HOST=0.0.0.0 \
    NODE_ENV=production

RUN mkdir -p /data /app/uploads /app/public /app/hugo-site/content /app/hugo-site/data \
 && chown -R bun:bun /data /app/uploads /app/public /app/hugo-site/content /app/hugo-site/data

USER bun
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD bun -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["bun", "run", "src/server.ts"]
