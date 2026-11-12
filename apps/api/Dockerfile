# Build context: repository root (npm workspaces).
FROM node:22-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci --workspace @opspilot/api --include-workspace-root
COPY apps/api apps/api
RUN npm run build --workspace @opspilot/api && npm prune --omit=dev --workspace @opspilot/api --include-workspace-root \
    && mkdir -p apps/api/node_modules

FROM node:22-slim
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/node_modules node_modules
# npm installs a dependency inside the workspace when its version conflicts with another
# workspace's copy; those must ship too or the process fails at startup with MODULE_NOT_FOUND.
COPY --from=build /app/apps/api/node_modules apps/api/node_modules
COPY --from=build /app/apps/api/dist apps/api/dist
COPY --from=build /app/apps/api/prisma apps/api/prisma
COPY --from=build /app/apps/api/package.json apps/api/package.json
WORKDIR /app/apps/api
USER node
EXPOSE 4000
CMD ["node", "dist/src/server.js"]
