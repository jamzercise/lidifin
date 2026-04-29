# ADR 0005: Postgres slow-query logging defaults

## Status

Accepted

## Context

Long-running SQL (Prisma or raw) is easier to tune when the database logs statements above a threshold. Defaults ship with logging effectively off for routine queries.

## Decision

- Set **`log_min_duration_statement = 500`** (milliseconds) for:
  - **Dev:** `docker-compose.dev.yml` Postgres `command:` overrides.
  - **All-in-one image:** `supervisord` postgres `command` in the `Dockerfile` includes the same `-c` flag.
- Values appear in **container logs** (stdout/stderr); no app code change required.

## Consequences

- Legitimately slow statements (>500 ms) show up in `docker compose logs`; sub-500 ms noise stays quiet.
- Operators on **external** Postgres (RDS, etc.) should set the same parameter in parameter groups if they want parity.
- If logs are too chatty on slow disks, raise the threshold (e.g. 1000 ms) in those two places.
