# Y2K Lounge

A Vite + React app in the Holo workspace focused on the Y2K nostalgic-futurism vibe.

## Development

From the repo root:

```bash
pnpm install
pnpm --filter @holo/y2k-lounge dev
```

## Scripts

```bash
pnpm --filter @holo/y2k-lounge build
pnpm --filter @holo/y2k-lounge preview
pnpm --filter @holo/y2k-lounge lint
pnpm --filter @holo/y2k-lounge format
pnpm --filter @holo/y2k-lounge typecheck
```

## Auth + API env

- `VITE_API_BASE_URL` (defaults to `http://localhost:8080`)
- `VITE_AUTH_BASE` (defaults to `https://jcvolpe.me`)
- `VITE_APP_NAME` (defaults to `y2k`)
- `VITE_AUTH_REQUIRED` (defaults to `false` in dev, `true` in prod)
