# Web app: built here so a server install needs only this folder.
FROM node:22-bookworm-slim AS web
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY web/ ./
RUN npm run build

# Server: TypeScript compiled to dist/.
FROM node:22-bookworm-slim AS server
WORKDIR /server
COPY server/package.json server/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY server/ ./
RUN npm run build && npm prune --omit=dev

# Runtime. Debian for osmium-tool (OSM extract imports in the worker).
FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends osmium-tool ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=server /server/node_modules ./node_modules
COPY --from=server /server/dist ./dist
COPY --from=server /server/package.json ./
COPY db/migrations ./migrations
COPY public ./public
COPY --from=web /web/dist ./web
ENV NODE_ENV=production
EXPOSE 80
CMD ["node", "dist/api.js"]
