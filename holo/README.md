# holo-2d3d (pnpm monorepo scaffold)

A scaffold for a 2D → (optional multi-view) → 3D *asset bake* pipeline, designed to be:

- **Composable**: consume packages from other web apps
- **Dev-friendly**: run everything locally (MacBook) during iteration
- **Deployable**: swap local adapters for AWS (S3/SQS + GPU workers) without changing the client API

## What you get

- `packages/img2mesh3d` — Python pipeline toolkit + FastAPI job API + SQS worker (local + AWS async).
- `packages/shared-spec` — TypeScript BakeSpec schema + types (single source of truth).
- `packages/sdk-js` — TypeScript SDK for submitting jobs + polling status.
- `packages/viewer-three` — Three.js viewer utilities/components (loads glTF/GLB).
- `apps/demo-web` — Example web app (upload → bake → view result).
- `docs/` — Architecture + local/dev + deployment docs **with embedded diagrams**.

> This is a scaffold: the pipeline uses Replicate + Meshy in `packages/img2mesh3d` for end-to-end wiring.

## Quick start (local dev)

See `docs/02-local-dev.md`.

## Docs

Start here:

- `docs/00-overview.md`
- `docs/01-architecture.md`
- `docs/02-local-dev.md`
- `docs/03-deployment-aws.md`

## License

MIT for the scaffold code (see each package for notes).
