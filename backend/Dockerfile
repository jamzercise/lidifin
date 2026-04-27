# Stage 1: Builder - install all deps, generate Prisma client, compile TypeScript
FROM node:20-slim AS builder

WORKDIR /app

# Copy package files and prisma schema for client generation + install
COPY package*.json ./
COPY prisma ./prisma/
COPY tsconfig.json ./

# Install ALL dependencies (need devDeps for tsc/prisma generate).
# Using `npm ci` here gives reproducible installs from package-lock.json.
RUN npm ci && npm cache clean --force

# Generate Prisma Client (uses schema in ./prisma)
RUN npx prisma generate

# Copy source and compile to JS. Compiling at build time:
#   - catches type errors before they ship
#   - eliminates the per-startup tsx transpilation cost (faster cold start)
#   - removes the runtime tsx dependency surface
COPY src ./src
RUN npm run build

# Stage 2: Runtime (hardened, non-root, compiled JS, prod-only deps)
# `prisma` is now a runtime dependency (not a devDep) so the entrypoint can run
# `prisma migrate deploy` and `prisma generate` against this slim install.
FROM node:20-slim AS runtime

WORKDIR /app

# Runtime system dependencies
# - ffmpeg: audio transcoding
# - openssl: required by Prisma's query engine
# - tini: PID 1 for proper signal handling
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    tini \
    openssl \
    && rm -rf /var/lib/apt/lists/*

# Install only production deps in the runtime image. This drops TypeScript,
# Jest, all `@types/*`, tsx, ts-jest, etc. — significantly smaller image and
# attack surface than copying the full builder node_modules.
COPY package*.json ./
COPY prisma ./prisma
RUN npm ci --omit=dev && npm cache clean --force

# Generate the Prisma client against the prod-only install (smaller, but the
# entrypoint also re-runs this against the live schema at boot for safety).
RUN npx prisma generate

# Compiled application code from the builder stage.
COPY --from=builder /app/dist ./dist

# Healthcheck + entrypoint
COPY healthcheck.js ./
COPY docker-entrypoint.sh /usr/local/bin/

# Create runtime dirs, normalize line endings, fix perms, then strip risky tooling
RUN mkdir -p /app/cache/covers /app/cache/transcodes /app/logs && \
    sed -i 's/\r$//' /usr/local/bin/docker-entrypoint.sh && \
    chmod +x /usr/local/bin/docker-entrypoint.sh && \
    chown -R node:node /app && \
    rm -f /usr/bin/wget /usr/bin/curl /bin/wget /bin/curl 2>/dev/null || true && \
    rm -f /usr/bin/nc /bin/nc /usr/bin/ncat /usr/bin/netcat 2>/dev/null || true && \
    rm -f /usr/bin/ftp /usr/bin/tftp /usr/bin/telnet 2>/dev/null || true

USER node

EXPOSE 3006

HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
    CMD ["node", "healthcheck.js"]

# tini reaps zombies and forwards signals (graceful shutdown handlers in src/index.ts rely on this).
ENTRYPOINT ["/usr/bin/tini", "--", "docker-entrypoint.sh"]
CMD ["node", "dist/index.js"]
