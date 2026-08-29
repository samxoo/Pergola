# Multi-stage: one image, both halves. The server serves the built client, so the
# whole app is one container on one port with no reverse proxy in the way.
#
# Build multi-arch so a Raspberry Pi or an ARM VPS is a first-class target:
#   docker buildx build --platform linux/amd64,linux/arm64 -f docker/Dockerfile .

FROM node:24-alpine AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable
WORKDIR /app

# ---- dependencies (cached until a manifest or the lockfile changes) ----------
FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile

# ---- build ------------------------------------------------------------------
FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages/shared/node_modules ./packages/shared/node_modules
COPY --from=deps /app/apps/server/node_modules ./apps/server/node_modules
COPY --from=deps /app/apps/web/node_modules ./apps/web/node_modules
COPY . .
# shared must be built first: the apps import its emitted .js, not its source.
RUN pnpm build

# ---- runtime ----------------------------------------------------------------
FROM base AS runtime
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/server/node_modules ./apps/server/node_modules
COPY --from=build /app/apps/server/dist ./apps/server/dist
COPY --from=build /app/apps/server/drizzle ./apps/server/drizzle
COPY --from=build /app/packages/shared ./packages/shared
# The client ships inside the server image and is served from ./public. The
# server's own build already places it there; copy the built directory as-is.
COPY --from=build /app/apps/server/public ./apps/server/public

WORKDIR /app/apps/server
EXPOSE 3000

# A container that is up but not receiving notifications should fail its
# healthcheck, not degrade silently. /health reports the listener's real state.
HEALTHCHECK --interval=30s --timeout=4s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

USER node
CMD ["node", "dist/index.js"]
