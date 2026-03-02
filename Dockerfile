# syntax=docker/dockerfile:1.4
# Lidifin - Jellyfin Music Client (All-in-One)
# Contains: Backend, Frontend, PostgreSQL, Redis, yt-dlp for YouTube Music
# Jellyfin-only: no Essentia/CLAP analyzers (vibe matching handled by Jellyfin AudioMuse AI plugin)
# Usage: docker run -d -p 31013:3030 -v lidifin_data:/data jamzercise/lidifin:latest

FROM node:20-slim

# Add PostgreSQL 16 repository (Debian Bookworm only has PG15 by default)
RUN apt-get update && apt-get install -y --no-install-recommends \
    gnupg lsb-release curl ca-certificates && \
    echo "deb http://apt.postgresql.org/pub/repos/apt $(lsb_release -cs)-pgdg main" > /etc/apt/sources.list.d/pgdg.list && \
    curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc | gpg --dearmor -o /etc/apt/trusted.gpg.d/postgresql.gpg && \
    apt-get update

# Install system dependencies (no Python/ML - Jellyfin-only deployment)
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

# Create directories
RUN mkdir -p /app/backend /app/frontend \
    /data/postgres /data/redis /run/postgresql /var/log/supervisor \
    && chown -R postgres:postgres /data/postgres /run/postgresql

# Create database readiness check script (outer heredoc so BuildKit parses as one RUN)
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
    if PGPASSWORD=lidify psql -h localhost -U lidify -d lidify -c "SELECT 1 FROM \"Track\" LIMIT 1" > /dev/null 2>&1; then
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
PGPASSWORD=lidify psql -h localhost -U lidify -d lidify -c "\dt" 2>&1 || echo "Could not list tables"
exit 1
INNER
chmod +x /app/wait-for-db.sh
sed -i 's/\r$//' /app/wait-for-db.sh
OUTER

# ============================================
# BACKEND BUILD
# ============================================
WORKDIR /app/backend

# Copy backend package files and install dependencies
COPY backend/package*.json ./
COPY backend/prisma ./prisma/
RUN echo "=== Migrations copied ===" && ls -la prisma/migrations/ && echo "=== End migrations ==="
# Use npm install so build works when package-lock.json is out of sync with package.json
RUN npm install && npm cache clean --force
RUN npx prisma generate

# Copy backend source and build
COPY backend/src ./src
COPY backend/tsconfig.json ./
RUN npm run build

COPY backend/docker-entrypoint.sh ./
COPY backend/healthcheck.js ./healthcheck-backend.js

# Create log directory (cache will be in /data volume)
RUN mkdir -p /app/backend/logs

# ============================================
# FRONTEND BUILD
# ============================================
WORKDIR /app/frontend

# Copy frontend package files and install dependencies
COPY frontend/package*.json ./
RUN npm install && npm cache clean --force

# Copy frontend source and build
COPY frontend/ ./

# Build Next.js (production)
ENV NEXT_PUBLIC_BACKEND_URL=http://127.0.0.1:3006
RUN npm run build

# ============================================
# YT-DLP (YouTube Music playlist import)
# ============================================
# Install before removing curl; backend finds it on PATH
RUN curl -L --progress-bar -o /usr/local/bin/yt-dlp \
    "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp" \
    && chmod +x /usr/local/bin/yt-dlp \
    && yt-dlp --version

# ============================================
# SECURITY HARDENING
# ============================================
# Remove dangerous tools AFTER all builds are complete
RUN \
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

# Create supervisord config - logs to stdout/stderr for Docker visibility (outer heredoc for BuildKit)
RUN <<'OUTER'
cat > /etc/supervisor/conf.d/lidify.conf << 'INNER'
[supervisord]
nodaemon=true
logfile=/dev/null
logfile_maxbytes=0
pidfile=/var/run/supervisord.pid
user=root

[program:postgres]
command=/usr/lib/postgresql/16/bin/postgres -D /data/postgres
user=postgres
autostart=true
autorestart=true
stdout_logfile=/dev/stdout
stdout_logfile_maxbytes=0
stderr_logfile=/dev/stderr
stderr_logfile_maxbytes=0
priority=10

[program:redis]
command=/usr/bin/redis-server --dir /data/redis --appendonly yes --save ""
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
command=/bin/bash -c "sleep 10 && cd /app/frontend && npm start"
autostart=true
autorestart=true
stdout_logfile=/dev/stdout
stdout_logfile_maxbytes=0
stderr_logfile=/dev/stderr
stderr_logfile_maxbytes=0
environment=NODE_ENV="production",BACKEND_URL="http://localhost:3006",PORT="3030"
priority=40
INNER
sed -i 's/\r$//' /etc/supervisor/conf.d/lidify.conf
OUTER

# Create startup script with root check (outer heredoc for BuildKit)
RUN <<'OUTER'
cat > /app/start.sh << 'INNER'
#!/bin/bash
set -e

# Security check: Warn if running internal services as root
# Note: This container runs multiple services, some require root for initial setup
# but individual services (postgres, backend processes) run as non-root users

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
echo "    - Auto-generated encryption keys"
echo "============================================================"
echo ""

# Find PostgreSQL binaries (version may vary)
PG_BIN=$(find /usr/lib/postgresql -name "bin" -type d | head -1)
if [ -z "$PG_BIN" ]; then
    echo "ERROR: PostgreSQL binaries not found!"
    exit 1
fi
echo "Using PostgreSQL from: $PG_BIN"

# Prepare data directories (bind-mount safe)
echo "Preparing data directories..."
mkdir -p /data/postgres /data/redis /run/postgresql

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

# Clean up stale PID file if exists
rm -f /data/postgres/postmaster.pid 2>/dev/null || true

# Initialize PostgreSQL if not already done
if [ ! -f /data/postgres/PG_VERSION ]; then
    echo "Initializing PostgreSQL database..."
    gosu postgres $PG_BIN/initdb -D /data/postgres

    # Configure PostgreSQL
    echo "host all all 0.0.0.0/0 md5" >> /data/postgres/pg_hba.conf
    echo "listen_addresses='*'" >> /data/postgres/postgresql.conf
fi

# Start PostgreSQL temporarily to create database and user
gosu postgres $PG_BIN/pg_ctl -D /data/postgres -w start

# Create user and database if they don't exist
gosu postgres psql -tc "SELECT 1 FROM pg_roles WHERE rolname = 'lidify'" | grep -q 1 || \
    gosu postgres psql -c "CREATE USER lidify WITH PASSWORD 'lidify';"
gosu postgres psql -tc "SELECT 1 FROM pg_database WHERE datname = 'lidify'" | grep -q 1 || \
    gosu postgres psql -c "CREATE DATABASE lidify OWNER lidify;"

# Create pgvector extension as superuser (required before migrations)
echo "Creating pgvector extension..."
gosu postgres psql -d lidify -c "CREATE EXTENSION IF NOT EXISTS vector;"

# Run Prisma migrations
cd /app/backend
export DATABASE_URL="postgresql://lidify:lidify@localhost:5432/lidify"
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
echo "✓ Schema ready flag created"

# Stop PostgreSQL (supervisord will start it)
gosu postgres $PG_BIN/pg_ctl -D /data/postgres -w stop

# Create persistent cache directories in /data volume
mkdir -p /data/cache/covers /data/cache/transcodes /data/secrets

# Load or generate persistent secrets
if [ -f /data/secrets/session_secret ]; then
    SESSION_SECRET=$(cat /data/secrets/session_secret)
    echo "Loaded existing SESSION_SECRET"
else
    SESSION_SECRET=$(openssl rand -hex 32)
    echo "$SESSION_SECRET" > /data/secrets/session_secret
    chmod 600 /data/secrets/session_secret
    echo "Generated and saved new SESSION_SECRET"
fi

if [ -f /data/secrets/encryption_key ]; then
    SETTINGS_ENCRYPTION_KEY=$(cat /data/secrets/encryption_key)
    echo "Loaded existing SETTINGS_ENCRYPTION_KEY"
else
    SETTINGS_ENCRYPTION_KEY=$(openssl rand -hex 32)
    echo "$SETTINGS_ENCRYPTION_KEY" > /data/secrets/encryption_key
    chmod 600 /data/secrets/encryption_key
    echo "Generated and saved new SETTINGS_ENCRYPTION_KEY"
fi

# Write environment file for backend
cat > /app/backend/.env << ENVEOF
NODE_ENV=production
DATABASE_URL=postgresql://lidify:lidify@localhost:5432/lidify
REDIS_URL=redis://localhost:6379
PORT=3006
MUSIC_PATH=/music
TRANSCODE_CACHE_PATH=/data/cache/transcodes
SESSION_SECRET=$SESSION_SECRET
SETTINGS_ENCRYPTION_KEY=$SETTINGS_ENCRYPTION_KEY
ENVEOF
# INTERNAL_API_SECRET: used by internal backend endpoints (optional for Jellyfin-only)
echo "INTERNAL_API_SECRET=\${INTERNAL_API_SECRET:-lidify-internal-aio}" >> /app/backend/.env

echo "Starting Lidifin..."
exec env \
    NODE_ENV=production \
    DATABASE_URL="postgresql://lidify:lidify@localhost:5432/lidify" \
    SESSION_SECRET="$SESSION_SECRET" \
    SETTINGS_ENCRYPTION_KEY="$SETTINGS_ENCRYPTION_KEY" \
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
