FROM node:20-alpine AS build
WORKDIR /app
RUN apk add --no-cache openssl libc6-compat
COPY package*.json ./
RUN npm ci
COPY . .
RUN npx prisma generate
RUN npm run build

FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production TZ=Asia/Karachi
RUN apk add --no-cache openssl libc6-compat
COPY package*.json ./
RUN npm ci --omit=dev
# The prod stage omits devDependencies, which drops the `prisma` CLI
# — but the CMD below runs `migrate deploy` at boot. Install the
# PINNED CLI (same range as the repo's devDependency) so boot never
# downloads an unpinned prisma from the registry.
RUN PRISMA_VERSION=$(node -e "console.log(require('./package.json').devDependencies.prisma)") && npm install --no-save "prisma@$PRISMA_VERSION"
COPY --from=build /app/dist ./dist
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/node_modules/.prisma ./node_modules/.prisma
EXPOSE 3000
# Round 5, D5-S45: a failed `migrate deploy` exits non-zero, and with
# `restart: unless-stopped` Compose restarts the container into the
# same failure — the failed _prisma_migrations row blocks every retry
# until someone runs `migrate resolve` manually (docs/DEPLOY.md §4).
# Alert on repeated migrate failures; do not let this loop run silent.
# Likewise Docker never restarts a container merely for failing its
# healthcheck — an unhealthy (health-503) API needs an external
# watchdog/alert, not a restart policy.
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/main"]
