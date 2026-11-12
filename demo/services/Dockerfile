# One image for the three demo services, the load generator and the telemetry bridge.
FROM node:22-alpine
WORKDIR /srv
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY src src
USER node
ENV NODE_ENV=production
CMD ["node", "--require", "./src/telemetry.cjs", "src/service.cjs"]
