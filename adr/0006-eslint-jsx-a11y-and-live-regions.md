# ADR 0006 — ESLint jsx-a11y in CI and screen-reader announcements for ephemeral UI

## Context

We want predictable accessibility hygiene without silently regressing UI behavior for sighted users. Two complementary mechanisms matter:

1. **Static checks** — catch common JSX mistakes (labels, interactive handlers, landmarks) before merge.
2. **Dynamic announcements** — transient banners, floating panels, and loaders should expose enough state for assistive tech when visual affordances alone are insufficient.

## Decision

### ESLint + jsx-a11y (`frontend/eslint.config.mjs`)

- Extend Next.js core-web-vitals + TypeScript presets.
- Merge **`eslint-plugin-jsx-a11y`** `recommended` rules mapped from **`error` → `warn`** so CI stays green while the catalog of ~90+ warnings is burned down incrementally.
- **Pull requests** against `main` run `npm run lint` in **`.github/workflows/pr-checks.yml`** (`lint-frontend` job). That run includes jsx-a11y as part of ESLint.

Remediation path: fix warnings over time; selectively promote individual `jsx-a11y/*` rules to `"error"` once the codebase is clean enough for that rule.

### Live regions (pattern)

- **Toast stack** (`frontend/lib/toast-context.tsx`) — container uses `aria-live="polite"`; error toasts use assertive where appropriate.
- **Audio errors** (`frontend/components/providers/AudioErrorBoundary.tsx`) — `aria-live="assertive"` for playback failures.
- **Route / modal loading** — e.g. fullscreen Suspense fallbacks: `role="status"`, `aria-live="polite"`, `aria-busy`, and concise `sr-only` copy.
- **Floating download queue** (`frontend/components/DownloadNotifications.tsx`) — `role="region"` + `aria-label` and a dedicated `sr-only` summary with `aria-live="polite"` for active / failed / completed counts.
- **Short-lived inline banners** — e.g. playlist preview chip: `role="status"` + `aria-live="polite"` around the message text.

Prefer **polite** for non-blocking updates; **assertive** only for errors or immediate playback issues.

## Consequences

- **`npm run lint`** reports jsx-a11y warnings locally the same as CI; **`npm run build`** is unaffected.
- Some third-party or highly custom components may need eslint-disable comments with a short justification when a rule is intentionally violated.
- Live-region text should stay **short and stable** (avoid announcing on every animation frame).

## Related

- [ADR 0005 — Postgres slow-query logging defaults](0005-postgres-observability-defaults.md) (operational observability complement).
