# syntax=docker/dockerfile:1
# --- builder ---------------------------------------------------------------
FROM node:22-bookworm-slim AS builder
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ git curl \
    && rm -rf /var/lib/apt/lists/*
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@10.33.2 --activate
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm build
RUN pnpm --filter @amem/web build
# strip devDependencies for a smaller runtime
ENV CI=true
RUN pnpm install --prod --frozen-lockfile

# --- runtime ---------------------------------------------------------------
FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages ./packages
COPY --from=builder /app/apps/web/dist ./apps/web/dist
RUN groupadd -r amem && useradd -r -g amem amem \
    && mkdir -p /data && chown -R amem:amem /data /app
USER amem
ENV AMEM_DB_PATH=/data/amem.db \
    AMEM_HOST=0.0.0.0 \
    AMEM_PORT=8321 \
    AMEM_WEB_DIR=/app/apps/web/dist
EXPOSE 8321
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8321/api/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "packages/server/dist/cli.js"]
