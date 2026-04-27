#!/bin/sh
set -e

# Security check: Refuse to run as root
if [ "$(id -u)" = "0" ]; then
  echo ""
  echo "╔══════════════════════════════════════════════════════════════╗"
  echo "║  FATAL: CANNOT START AS ROOT                                 ║"
  echo "║                                                              ║"
  echo "║  Running as root is a security risk. This container must    ║"
  echo "║  run as a non-privileged user.                              ║"
  echo "║                                                              ║"
  echo "║  Do NOT use:                                                 ║"
  echo "║    - docker run --user root                                  ║"
  echo "║    - user: root in docker-compose.yml                        ║"
  echo "║                                                              ║"
  echo "║  The container is configured to run as 'node' user.         ║"
  echo "╚══════════════════════════════════════════════════════════════╝"
  echo ""
  exit 1
fi

echo "[START] Starting Lidifin Backend..."

# Docker Compose health checks ensure database and Redis are ready
# Add a small delay to be extra safe
echo "[WAIT] Waiting for services to be ready..."
sleep 3
echo "Services are ready"

# Run database migrations
echo "[DB] Running database migrations..."
npx prisma migrate deploy

# Generate Prisma client (in case of schema changes)
echo "[DB] Generating Prisma client..."
npx prisma generate

# Clear Redis cache on deployment to prevent stale data (e.g., 404 images)
echo "[REDIS] Clearing cache for fresh deployment..."
node -e "
const { createClient } = require('redis');
const client = createClient({ url: process.env.REDIS_URL || 'redis://redis:6379' });
client.connect()
  .then(() => client.flushAll())
  .then(() => { console.log('[REDIS] Cache cleared successfully'); return client.quit(); })
  .catch(err => { console.warn('[REDIS] Cache clear failed (non-critical):', err.message); });
" || echo "[REDIS] Cache clear skipped (Redis unavailable)"

# In production, refuse to start without these secrets. The previous fallbacks
# (random per-restart SESSION_SECRET, hardcoded SETTINGS_ENCRYPTION_KEY) are
# unsafe:
#   - regenerated SESSION_SECRET logs out every user on every restart
#   - hardcoded SETTINGS_ENCRYPTION_KEY means anyone running default config
#     shares an encryption key with every other default-config deployment, so
#     stored credentials can be decrypted cross-instance
# Outside production we still fall back so dev/test boot cleanly.
IS_PRODUCTION="false"
if [ "${NODE_ENV:-production}" = "production" ]; then
  IS_PRODUCTION="true"
fi

if [ -z "$SESSION_SECRET" ] || [ "$SESSION_SECRET" = "changeme-generate-secure-key" ]; then
  if [ "$IS_PRODUCTION" = "true" ]; then
    echo "[FATAL] SESSION_SECRET is not set (or still set to the changeme placeholder)."
    echo "        Refusing to start in production. Set SESSION_SECRET to a stable, secret"
    echo "        value of at least 32 random bytes (e.g. \`openssl rand -base64 32\`)."
    exit 1
  fi
  echo "[WARN] SESSION_SECRET not set. Generating an ephemeral key for non-production use."
  export SESSION_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('base64'))")
fi

if [ -z "$SETTINGS_ENCRYPTION_KEY" ] || [ "$SETTINGS_ENCRYPTION_KEY" = "default-encryption-key-change-me" ]; then
  if [ "$IS_PRODUCTION" = "true" ]; then
    echo "[FATAL] SETTINGS_ENCRYPTION_KEY is not set (or still set to the default placeholder)."
    echo "        Refusing to start in production. Using the default key would let any"
    echo "        default-config deployment decrypt this instance's stored credentials."
    echo "        Set SETTINGS_ENCRYPTION_KEY to a unique 32-character secret."
    exit 1
  fi
  echo "[WARN] SETTINGS_ENCRYPTION_KEY not set. Using development default for non-production use."
  export SETTINGS_ENCRYPTION_KEY="default-encryption-key-change-me"
fi

echo "[START] Lidifin Backend starting on port ${PORT:-3006}..."
echo "[CONFIG] Music path: ${MUSIC_PATH:-/music}"
echo "[CONFIG] Environment: ${NODE_ENV:-production}"

# Execute the main command
exec "$@"
