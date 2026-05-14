FROM node:20-alpine AS deps
RUN apk add --no-cache git openssh-client ca-certificates
WORKDIR /app

# Copy workspace manifests for an efficient install layer
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json tsconfig.json ./
COPY artifacts/api-server/package.json artifacts/api-server/
COPY lib/api-zod/package.json lib/api-zod/
COPY lib/api-spec/package.json lib/api-spec/
COPY lib/api-client-react/package.json lib/api-client-react/
COPY lib/db/package.json lib/db/
COPY scripts/package.json scripts/

RUN corepack enable && pnpm install --frozen-lockfile=false

FROM deps AS build
COPY . .
RUN pnpm --filter @workspace/api-zod build
RUN pnpm --filter @workspace/api-server build

FROM node:20-alpine AS runtime
RUN apk add --no-cache git openssh-client ca-certificates tini
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000
ENV VAULT_CACHE_DIR=/vault-cache

# Copy fully-bundled output (esbuild produces a single dist directory)
COPY --from=build /app/artifacts/api-server/dist ./dist
COPY --from=build /app/artifacts/api-server/package.json ./package.json

RUN mkdir -p /vault-cache

EXPOSE 3000
HEALTHCHECK --interval=60s --timeout=5s --start-period=30s --retries=3 \
  CMD wget -qO- http://127.0.0.1:${PORT}/api/healthz >/dev/null || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "--enable-source-maps", "./dist/index.mjs", "http"]
