# syntax=docker/dockerfile:1.4
# Lidifin - Jellyfin Music Client (All-in-One)
# Contains: Backend, Frontend, PostgreSQL, Redis, yt-dlp for YouTube Music
# Jellyfin-only: no Essentia/CLAP analyzers (vibe matching handled by Jellyfin AudioMuse AI plugin)
# Usage: docker run -d -p 31013:3030 -v lidifin_data:/data jamzercise/lidifin:latest
#
# Multi-stage layout:
#   backend-builder  - full deps, prisma generate, tsc build
#   backend-deps     - production-only node_modules (+ prisma client)
#   frontend-builder - Next.js standalone build
#   runtime          - slim final image: Postgres, Redis, supervisord,
#                      compiled backend + prod deps, standalone frontend.
#                      App processes run as the non-root `node` user;
#                      Postgres/Redis bind to loopback only; secrets are
#                      generated at first boot and persisted in /data/secrets.

# ============================================
# BACKEND BUILDER (all deps + tsc)
# ============================================
FROM node:20-slim AS backend-builder

WORKDIR /app/backend

COPY backend/package*.json ./
COPY backend/prisma ./prisma/
# Use npm install so build works when package-lock.json is out of sync with package.json
RUN npm install && npm cache clean --force
RUN npx prisma generate

COPY backend/src ./src
COPY backend/tsconfig.json ./
RUN npm run build

# ============================================
# BACKEND PRODUCTION DEPS (no devDependencies)
# ============================================
FROM node:20-slim AS backend-deps

WORKDIR /app/backend

# openssl for Prisma engine download/generation
RUN apt-get update && apt-get install -y --no-install-recommends openssl \
    && rm -rf /var/lib/apt/lists/*

COPY backend/package*.json ./
COPY backend/prisma ./prisma/
RUN npm install --omit=dev && npm cache clean --force
# Prisma client generated against the prod-only install. `prisma` is a
# runtime dependency so `npx prisma migrate deploy` works at boot.
RUN npx prisma generate

# ============================================
# FRONTEND BUILDER (standalone output)
# ============================================
FROM node:20-slim AS frontend-builder

WORKDIR /app/frontend

COPY frontend/package*.json ./
RUN npm install && npm cache clean --force

COPY frontend/ ./

# Build Next.js in standalone mode. The AIO runtime then only needs
# .next/standalone (self-contained server + pruned node_modules),
# .next/static, and public — not the full dev node_modules tree.
ENV NEXT_PUBLIC_BACKEND_URL=http://127.0.0.1:3006
ENV BUILD_STANDALONE=1
RUN npm run build

# ============================================
# RUNTIME
# ============================================
FROM node:20-slim AS runtime

# Add PostgreSQL 16 repository (Debian Bookworm only has PG15 by default)
RUN apt-get update && apt-get install -y --no-install-recommends \
    gnupg lsb-release curl ca-certificates && \
    echo "deb http://apt.postgresql.org/pub/repos/apt $(lsb_release -cs)-pgdg main" > /etc/apt/sources.list.d/pgdg.list && \
    curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc | gpg --dearmor -o /etc/apt/trusted.gpg.d/postgresql.gpg && \
    apt-get update

# Install system dependencies (no Python/ML - Jellyfin-only deployment)
# Note: supervisor pulls in python3, which yt-dlp also needs.
RUN apt-get install -y --no-install-recommends \
    postgresql-16 \
    postgresql-16-pgvector \
    redis-server \
    supervisor \
    tini \
    openssl \
    bash \
    gosu \
    && rm -rf /var/lib/apt/lists/*

# ============================================
# YT-DLP (YouTube Music playlist import)
# ============================================
# Install before removing curl; backend finds it on PATH
RUN curl -L --progress-bar -o /usr/local/bin/yt-dlp \
    "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp" \
    && chmod +x /usr/local/bin/yt-dlp \
    && yt-dlp --version

# Create directories
RUN mkdir -p /app/backend /app/frontend \
    /data/postgres /data/redis /run/postgresql /var/log/supervisor \
    && chown -R postgres:postgres /data/postgres /run/postgresql

# ============================================
# BACKEND (compiled JS + prod-only deps)
# ============================================
# App files are copied with --chown=node:node (the user supervisord runs the
# app processes as). A recursive `chown -R /app` after the fact would rewrite
# every node_modules file into a new layer — slow and doubles the image size.
WORKDIR /app/backend

COPY --chown=node:node backend/package*.json ./
COPY --chown=node:node backend/prisma ./prisma/
COPY --from=backend-deps --chown=node:node /app/backend/node_modules ./node_modules
COPY --from=backend-builder --chown=node:node /app/backend/dist ./dist
COPY --chown=node:node backend/healthcheck.js ./healthcheck-backend.js

# Log directory (cache lives in the /data volume). Also make the /app and
# /app/backend directories themselves node-owned (non-recursive, instant) so
# the backend can create files like /app/.env at runtime.
RUN mkdir -p /app/backend/logs \
    && chown node:node /app /app/backend /app/backend/logs /app/frontend

# ============================================
# FRONTEND (Next.js standalone server)
# ============================================
WORKDIR /app/frontend

COPY --from=frontend-builder --chown=node:node /app/frontend/.next/standalone ./
COPY --from=frontend-builder --chown=node:node /app/frontend/.next/static ./.next/static
COPY --from=frontend-builder --chown=node:node /app/frontend/public ./public

# ============================================
# SECURITY HARDENING
# ============================================
# Remove dangerous tools AFTER all installs are complete
RUN \
    apt-get purge -y gnupg lsb-release curl 2>/dev/null || true && \
    apt-get autoremove -y 2>/dev/null || true && \
    rm -f /usr/bin/wget /bin/wget 2>/dev/null || true && \
    rm -f /usr/bin/curl /bin/curl 2>/dev/null || true && \
    rm -f /usr/bin/nc /bin/nc /usr/bin/ncat /usr/bin/netcat 2>/dev/null || true && \
    rm -f /usr/bin/ftp /usr/bin/tftp /usr/bin/telnet 2>/dev/null || true && \
    rm -rf /var/lib/apt/lists/*

# ============================================
# CONFIGURATION
# ============================================
WORKDIR /app

# Copy healthcheck script
COPY healthcheck-prod.js /app/healthcheck.js

# Create database readiness check script (outer heredoc so BuildKit parses as one RUN)
# DB_PASSWORD is inherited from supervisord's environment (set by start.sh).
RUN <<'OUTER'
cat > /app/wait-for-db.sh << 'INNER'
#!/bin/bash
TIMEOUT=${1:-120}
COUNTER=0

echo "[wait-for-db] Waiting for database schema (timeout: ${TIMEOUT}s)..."

# Quick check for schema ready flag
if [ -f /data/.schema_ready ]; then
    echo "[wait-for-db] Schema ready flag found, verifying connection..."
fi

while [ $COUNTER -lt $TIMEOUT ]; do
    if PGPASSWORD="$DB_PASSWORD" psql -h 127.0.0.1 -U lidify -d lidify -c "SELECT 1 FROM \"Track\" LIMIT 1" > /dev/null 2>&1; then
        echo "[wait-for-db] ✓ Database is ready and schema exists!"
        exit 0
    fi

    if [ $((COUNTER % 15)) -eq 0 ]; then
        echo "[wait-for-db] Still waiting... (${COUNTER}s elapsed)"
    fi

    sleep 1
    COUNTER=$((COUNTER + 1))
done

echo "[wait-for-db] ERROR: Database schema not ready after ${TIMEOUT}s"
echo "[wait-for-db] Listing available tables:"
PGPASSWORD="$DB_PASSWORD" psql -h 127.0.0.1 -U lidify -d lidify -c "\dt" 2>&1 || echo "Could not list tables"
exit 1
INNER
chmod +x /app/wait-for-db.sh
sed -i 's/\r$//' /app/wait-for-db.sh
OUTER

# Create supervisord config - logs to stdout/stderr for Docker visibility (outer heredoc for BuildKit)
# Backend, worker, and frontend run as the unprivileged `node` user.
# Postgres binds to loopback only; Redis binds to loopback only.
RUN <<'OUTER'
cat > /etc/supervisor/conf.d/lidify.conf << 'INNER'
[supervisord]
nodaemon=true
logfile=/dev/null
logfile_maxbytes=0
pidfile=/var/run/supervisord.pid
user=root

[program:postgres]
command=/usr/lib/postgresql/16/bin/postgres -D /data/postgres -c log_min_duration_statement=500
user=postgres
autostart=true
autorestart=true
stdout_logfile=/dev/stdout
stdout_logfile_maxbytes=0
stderr_logfile=/dev/stderr
stderr_logfile_maxbytes=0
priority=10

[program:redis]
command=/usr/bin/redis-server --dir /data/redis --appendonly yes --save "" --bind 127.0.0.1 -::1 --protected-mode yes
user=redis
autostart=true
autorestart=true
stdout_logfile=/dev/stdout
stdout_logfile_maxbytes=0
stderr_logfile=/dev/stderr
stderr_logfile_maxbytes=0
priority=20

[program:backend]
command=/bin/bash -c "/app/wait-for-db.sh 120 && cd /app/backend && node dist/index.js"
user=node
autostart=true
autorestart=unexpected
startretries=3
startsecs=10
stdout_logfile=/dev/stdout
stdout_logfile_maxbytes=0
stderr_logfile=/dev/stderr
stderr_logfile_maxbytes=0
directory=/app/backend
priority=30

[program:backend-worker]
command=/bin/bash -c "/app/wait-for-db.sh 120 && cd /app/backend && node dist/workerEntry.js"
user=node
autostart=true
autorestart=true
startretries=3
startsecs=10
stdout_logfile=/dev/stdout
stdout_logfile_maxbytes=0
stderr_logfile=/dev/stderr
stderr_logfile_maxbytes=0
directory=/app/backend
priority=35

[program:frontend]
command=/bin/bash -c "sleep 10 && cd /app/frontend && node server.js"
user=node
autostart=true
autorestart=true
stdout_logfile=/dev/stdout
stdout_logfile_maxbytes=0
stderr_logfile=/dev/stderr
stderr_logfile_maxbytes=0
environment=NODE_ENV="production",BACKEND_URL="http://localhost:3006",PORT="3030",HOSTNAME="0.0.0.0"
priority=40
INNER
sed -i 's/\r$//' /etc/supervisor/conf.d/lidify.conf
OUTER

# Create startup script (outer heredoc for BuildKit)
RUN <<'OUTER'
cat > /app/start.sh << 'INNER'
#!/bin/bash
set -e

# This script runs as root for initial setup (chown, Postgres init,
# migrations). Long-running services drop privileges via supervisord:
# postgres -> postgres, redis -> redis, backend/worker/frontend -> node.

echo ""
echo "============================================================"
echo "  Lidifin - Jellyfin Music Client"
echo ""
echo "  Features:"
echo "    - Jellyfin library integration"
echo "    - Smart playlists & favorites"
echo "    - High-quality audio streaming"
echo ""
echo "  Security:"
echo "    - Hardened container (no wget/curl/nc)"
echo "    - Auto-generated secrets (DB password, session, encryption)"
echo "    - Postgres/Redis bound to localhost, non-root app processes"
echo "============================================================"
echo ""

# Find PostgreSQL binaries (version may vary)
PG_BIN=$(find /usr/lib/postgresql -name "bin" -type d | head -1)
if [ -z "$PG_BIN" ]; then
    echo "ERROR: PostgreSQL binaries not found!"
    exit 1
fi
echo "Using PostgreSQL from: $PG_BIN"

# ---------------------------------------------------------
# Optional PUID/PGID remap of the unprivileged `node` user.
#
# Bind-mounted media is normally owned by an existing host account
# (for example 568:568, the `apps` user on TrueNAS). Remapping `node`
# to match is cleaner than layering ACLs onto the media tree, and it
# means files this container creates are owned exactly like the ones
# Lidarr and Jellyfin already produce.
#
# This must happen before supervisord starts. Supervisord resolves a
# program's uid, gid, and supplementary groups from /etc/passwd and
# /etc/group at spawn time and calls setgroups() with that result, so
# identity changes made afterwards - or supplementary groups injected
# via the container runtime - are ignored.
# ---------------------------------------------------------
if [ -n "${PUID:-}" ] || [ -n "${PGID:-}" ]; then
    if ! command -v usermod >/dev/null 2>&1 || ! command -v groupmod >/dev/null 2>&1; then
        echo "ERROR: PUID/PGID was set but usermod/groupmod are not available in this image."
        exit 1
    fi

    CURRENT_UID=$(id -u node)
    CURRENT_GID=$(id -g node)
    TARGET_UID="${PUID:-$CURRENT_UID}"
    TARGET_GID="${PGID:-$CURRENT_GID}"

    case "$TARGET_UID$TARGET_GID" in
        *[!0-9]*)
            echo "ERROR: PUID/PGID must be numeric (got PUID='${PUID:-}' PGID='${PGID:-}')."
            exit 1
            ;;
    esac

    # -o permits a duplicate id, in case the target collides with an
    # account that already exists inside the image.
    if [ "$TARGET_GID" != "$CURRENT_GID" ]; then
        groupmod -o -g "$TARGET_GID" node
        echo "Remapped group 'node': ${CURRENT_GID} -> ${TARGET_GID}"
    fi
    if [ "$TARGET_UID" != "$CURRENT_UID" ]; then
        usermod -o -u "$TARGET_UID" node
        echo "Remapped user 'node': ${CURRENT_UID} -> ${TARGET_UID}"
    fi

    # Re-own only what the app actually writes to. Deliberately not a
    # recursive chown of /app: node_modules is world-readable, so reads
    # keep working, and rewriting it would recreate the slow layer that
    # copying with --chown=node:node was introduced to avoid.
    chown "$TARGET_UID:$TARGET_GID" /app /app/backend /app/frontend 2>/dev/null || true
    chown -R "$TARGET_UID:$TARGET_GID" /app/backend/logs 2>/dev/null || true
fi

# Prepare data directories (bind-mount safe)
echo "Preparing data directories..."
mkdir -p /data/postgres /data/redis /run/postgresql /data/secrets
chmod 700 /data/secrets

if id postgres >/dev/null 2>&1; then
    chown -R postgres:postgres /data/postgres /run/postgresql 2>/dev/null || true
    chmod 700 /data/postgres 2>/dev/null || true
    if ! gosu postgres test -w /data/postgres; then
        POSTGRES_UID=$(id -u postgres)
        POSTGRES_GID=$(id -g postgres)
        echo "ERROR: /data/postgres is not writable by postgres (${POSTGRES_UID}:${POSTGRES_GID})."
        echo "If you bind-mount /data, ensure the host path is writable by that UID/GID."
        exit 1
    fi
fi

if id redis >/dev/null 2>&1; then
    chown -R redis:redis /data/redis 2>/dev/null || true
    chmod 700 /data/redis 2>/dev/null || true
    if ! gosu redis test -w /data/redis; then
        REDIS_UID=$(id -u redis)
        REDIS_GID=$(id -g redis)
        echo "ERROR: /data/redis is not writable by redis (${REDIS_UID}:${REDIS_GID})."
        echo "If you bind-mount /data, ensure the host path is writable by that UID/GID."
        exit 1
    fi
fi

# Downloads are written to /music by the backend as the unprivileged `node`
# user (Soulseek transfers, single-track grabs, the Singles organizer).
# Jellyfin-only deployments stream from Jellyfin and never write here, so an
# unwritable /music is a warning rather than a fatal error. Without this
# check the first symptom is a per-download "Cannot create destination
# directory: EACCES" buried in the Activity panel.
if id node >/dev/null 2>&1 && [ -d /music ]; then
    NODE_UID=$(id -u node)
    NODE_GID=$(id -g node)
    if gosu node test -w /music; then
        echo "Music path /music is writable by node (${NODE_UID}:${NODE_GID})"
    else
        MUSIC_OWNER=$(stat -c '%U:%G (%u:%g), mode %a' /music 2>/dev/null || echo "unknown")
        echo ""
        echo "WARNING: /music is not writable by the app user node (${NODE_UID}:${NODE_GID})."
        echo "         Playback from Jellyfin is unaffected, but every download will"
        echo "         fail with: Cannot create destination directory: EACCES"
        echo ""
        echo "         /music inside the container is owned by: ${MUSIC_OWNER}"
        echo ""
        echo "         Simplest fix - run the app as whoever owns that path, by"
        echo "         setting PUID and PGID on the container. For the owner shown"
        echo "         above that means:"
        echo "           PUID=$(stat -c '%u' /music 2>/dev/null || echo '<uid>')  PGID=$(stat -c '%g' /music 2>/dev/null || echo '<gid>')"
        echo ""
        echo "         Alternatively, grant uid ${NODE_UID} write access on the host."
        echo "         POSIX ACL filesystems (ext4, xfs):"
        echo "           setfacl -R    -m u:${NODE_UID}:rwX /path/to/music"
        echo "           setfacl -R -d -m u:${NODE_UID}:rwX /path/to/music"
        echo "         ZFS datasets with acltype=nfsv4 (TrueNAS) do not support"
        echo "         setfacl - use the dataset ACL editor or nfs4xdr_setfacl."
        echo "         Matching PUID/PGID avoids the problem entirely."
        echo ""
    fi
fi

# ---------------------------------------------------------
# Secrets: load from env if provided, else load/generate a
# persisted value under /data/secrets (survives upgrades).
# ---------------------------------------------------------
load_or_generate_secret() {
    # $1 = env value (may be empty), $2 = file path, $3 = label
    local env_value="$1" file_path="$2" label="$3" value
    if [ -n "$env_value" ]; then
        value="$env_value"
        echo "Using ${label} from environment" >&2
    elif [ -f "$file_path" ]; then
        value=$(cat "$file_path")
        echo "Loaded existing ${label}" >&2
    else
        value=$(openssl rand -hex 32)
        echo "$value" > "$file_path"
        chmod 600 "$file_path"
        echo "Generated and saved new ${label}" >&2
    fi
    printf '%s' "$value"
}

SESSION_SECRET=$(load_or_generate_secret "${SESSION_SECRET:-}" /data/secrets/session_secret "SESSION_SECRET")
SETTINGS_ENCRYPTION_KEY=$(load_or_generate_secret "${SETTINGS_ENCRYPTION_KEY:-}" /data/secrets/encryption_key "SETTINGS_ENCRYPTION_KEY")
INTERNAL_API_SECRET=$(load_or_generate_secret "${INTERNAL_API_SECRET:-}" /data/secrets/internal_api_secret "INTERNAL_API_SECRET")
DB_PASSWORD=$(load_or_generate_secret "${DB_PASSWORD:-}" /data/secrets/db_password "database password")

# Clean up stale PID file if exists
rm -f /data/postgres/postmaster.pid 2>/dev/null || true

# Initialize PostgreSQL if not already done
if [ ! -f /data/postgres/PG_VERSION ]; then
    echo "Initializing PostgreSQL database..."
    # peer auth for local socket (lets this script run psql as postgres),
    # scram for TCP connections (backend authenticates with DB_PASSWORD)
    gosu postgres $PG_BIN/initdb -D /data/postgres --auth-local=peer --auth-host=scram-sha-256
fi

# Enforce loopback-only Postgres on every boot (also fixes clusters
# initialized by older images that listened on all interfaces).
PG_CONF=/data/postgres/postgresql.conf
PG_HBA=/data/postgres/pg_hba.conf
sed -i "/^listen_addresses/d" "$PG_CONF"
echo "listen_addresses='127.0.0.1'" >> "$PG_CONF"
# Drop the old wide-open rule from previous image versions
sed -i '/^host all all 0\.0\.0\.0\/0 md5$/d' "$PG_HBA"
grep -q "^host all all 127.0.0.1/32" "$PG_HBA" || \
    echo "host all all 127.0.0.1/32 scram-sha-256" >> "$PG_HBA"

# Start PostgreSQL temporarily to create database and user
gosu postgres $PG_BIN/pg_ctl -D /data/postgres -w start

# Create user and database if they don't exist
gosu postgres psql -tc "SELECT 1 FROM pg_roles WHERE rolname = 'lidify'" | grep -q 1 || \
    gosu postgres psql -c "CREATE USER lidify;"
# Always (re)apply the generated password — this migrates old installs off
# the hardcoded default without any manual steps. Pass via psql variable on
# stdin (psql does not interpolate variables in -c commands) so the secret
# never appears in process args/logs.
echo "ALTER USER lidify WITH PASSWORD :'pw';" | gosu postgres psql -v pw="$DB_PASSWORD"
gosu postgres psql -tc "SELECT 1 FROM pg_database WHERE datname = 'lidify'" | grep -q 1 || \
    gosu postgres psql -c "CREATE DATABASE lidify OWNER lidify;"

# Create pgvector extension as superuser (required before migrations)
echo "Creating pgvector extension..."
gosu postgres psql -d lidify -c "CREATE EXTENSION IF NOT EXISTS vector;"

# Run Prisma migrations
cd /app/backend
export DATABASE_URL="postgresql://lidify:${DB_PASSWORD}@localhost:5432/lidify"
echo "Running Prisma migrations..."
ls -la prisma/migrations/ || echo "No migrations directory!"

# Check if _prisma_migrations table exists (indicates previous Prisma setup)
MIGRATIONS_EXIST=$(gosu postgres psql -d lidify -tAc "SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_name = '_prisma_migrations')" 2>/dev/null || echo "f")

# Check if User table exists (indicates existing data)
USER_TABLE_EXIST=$(gosu postgres psql -d lidify -tAc "SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'User')" 2>/dev/null || echo "f")

# Handle rename migration for existing databases
echo "Checking if rename migration needs to be marked as applied..."
if gosu postgres psql -d lidify -tAc "SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='SystemSettings' AND column_name='soulseekFallback');" 2>/dev/null | grep -q 't'; then
    echo "Old column exists, marking migration as applied..."
    gosu postgres psql -d lidify -c "INSERT INTO \"_prisma_migrations\" (id, checksum, finished_at, migration_name, logs, rolled_back_at, started_at, applied_steps_count) VALUES (gen_random_uuid(), '', NOW(), '20250101000000_rename_soulseek_fallback', '', NULL, NOW(), 1) ON CONFLICT DO NOTHING;" 2>/dev/null || true
fi

if [ "$MIGRATIONS_EXIST" = "t" ]; then
    # Normal migration flow - migrations table exists
    echo "Migration history found, running migrate deploy..."
    if ! npx prisma migrate deploy 2>&1; then
        echo "FATAL: Database migration failed! Check logs above."
        exit 1
    fi
elif [ "$USER_TABLE_EXIST" = "t" ]; then
    # Database has data but no migrations table - needs baseline
    echo "Existing database detected without migration history."
    echo "Creating baseline from current schema..."
    # Mark the init migration as already applied (baseline)
    npx prisma migrate resolve --applied 20241130000000_init 2>&1 || true
    # Now run any subsequent migrations
    if ! npx prisma migrate deploy 2>&1; then
        echo "FATAL: Migration after baseline failed!"
        exit 1
    fi
else
    # Fresh database - run migrations normally
    echo "Fresh database detected, running initial migrations..."
    if ! npx prisma migrate deploy 2>&1; then
        echo "FATAL: Initial migration failed. Check database connection and schema."
        exit 1
    fi
fi
echo "✓ Migrations completed successfully"

# Verify schema exists before starting services
echo "Verifying database schema..."
if ! gosu postgres psql -d lidify -c "SELECT 1 FROM \"Track\" LIMIT 1" >/dev/null 2>&1; then
    echo "FATAL: Track table does not exist after migration!"
    echo "Database schema verification failed. Container will exit."
    exit 1
fi
echo "✓ Schema verification passed"

# Create flag file for wait-for-db.sh
touch /data/.schema_ready

# Stop PostgreSQL (supervisord will start it)
gosu postgres $PG_BIN/pg_ctl -D /data/postgres -w stop

# Create persistent cache directories in /data volume, writable by the
# unprivileged node user that runs the backend
mkdir -p /data/cache/covers /data/cache/transcodes
chown -R node:node /data/cache 2>/dev/null || true

# Write environment file for backend (owned by node, not world-readable)
cat > /app/backend/.env << ENVEOF
NODE_ENV=production
DATABASE_URL=postgresql://lidify:${DB_PASSWORD}@localhost:5432/lidify
REDIS_URL=redis://localhost:6379
PORT=3006
BIND_HOST=127.0.0.1
MUSIC_PATH=/music
TRANSCODE_CACHE_PATH=/data/cache/transcodes
SESSION_SECRET=$SESSION_SECRET
SETTINGS_ENCRYPTION_KEY=$SETTINGS_ENCRYPTION_KEY
INTERNAL_API_SECRET=$INTERNAL_API_SECRET
ENVEOF
chown node:node /app/backend/.env
chmod 600 /app/backend/.env

echo "Starting Lidifin..."
exec env \
    NODE_ENV=production \
    DATABASE_URL="postgresql://lidify:${DB_PASSWORD}@localhost:5432/lidify" \
    DB_PASSWORD="$DB_PASSWORD" \
    SESSION_SECRET="$SESSION_SECRET" \
    SETTINGS_ENCRYPTION_KEY="$SETTINGS_ENCRYPTION_KEY" \
    INTERNAL_API_SECRET="$INTERNAL_API_SECRET" \
    /usr/bin/supervisord -c /etc/supervisor/supervisord.conf
INNER
sed -i 's/\r$//' /app/start.sh
chmod +x /app/start.sh
OUTER

# Expose ports
EXPOSE 3030

# Health check using Node.js (no wget)
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
    CMD ["node", "/app/healthcheck.js"]

# Volumes
VOLUME ["/music", "/data"]

# Use tini for proper signal handling
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["/app/start.sh"]
