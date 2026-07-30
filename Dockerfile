# =============================================================================
# STX Shield services -- one image, parametrized by SERVICE (api | relayer)
# =============================================================================
#   docker build --build-arg SERVICE=api     -t stx-shield-api .
#   docker build --build-arg SERVICE=relayer -t stx-shield-relayer .
# Build context is the repo root so services/<SERVICE> is available.

FROM node:22-slim AS build
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
WORKDIR /app
ARG SERVICE=api
COPY services/${SERVICE}/package.json ./package.json
RUN pnpm install --no-frozen-lockfile
COPY services/${SERVICE}/ ./
RUN pnpm build

FROM node:22-slim AS runtime
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
WORKDIR /app
ARG SERVICE=api
ENV NODE_ENV=production
ENV SERVICE=${SERVICE}
# Copy the built service with its dependencies. devDeps are kept so the api can
# run `drizzle-kit push` at startup; images are pruned in a later optimization.
COPY --from=build /app ./
EXPOSE 8888 8787
# The compose file overrides `command` per service (the api runs migrations
# first). Default is to start the built entry point.
CMD ["node", "dist/index.js"]
