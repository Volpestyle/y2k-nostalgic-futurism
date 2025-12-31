# Architecture

This scaffold uses a **job-based** design so heavy 2D→3D bakes can scale from local dev to cloud GPU workers.

## High-level components

![System context](./images/01-system-context.png)

## Job flow (async)

![Job flow](./images/02-job-flow.png)

## Monorepo packages and boundaries

![Monorepo packages](./images/03-monorepo-packages.png)

## Local vs deployed adapter swapping

![Adapters](./images/04-adapters-local-vs-cloud.png)

## Notes

- The img2mesh3d API + worker live in `packages/img2mesh3d`.
- In local dev, the API can run the pipeline in-process with a local artifact directory.
- In the cloud, these can become S3 + DynamoDB + SQS + GPU workers.

---

### Regenerating diagrams

- Mermaid sources live in `docs/diagrams/*.mmd`.
- PNGs live in `docs/images/*.png`.

To regenerate PNGs from Mermaid (recommended once you have Docker):

```bash
./scripts/render-mermaid-pngs.sh
```

If you are fully offline, there's also a graphviz fallback (uses `docs/diagrams-dot/*.dot`):

```bash
./scripts/render-diagrams-dot.sh
```
