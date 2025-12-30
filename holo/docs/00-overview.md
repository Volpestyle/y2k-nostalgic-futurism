# Overview

This repo separates **traffic-handling** from **GPU baking**:

- **img2mesh3d (`packages/img2mesh3d`)** provides the FastAPI job API, SQS worker, and the pipeline stages.
- **BakeSpec (`packages/shared-spec`)** is a versioned JSON contract shared by all apps/services.

Why this shape?

- The client API stays stable while you swap implementations:
  - local: filesystem + in-process job runner
  - cloud: S3 + SQS + GPU workers

## Pipeline stages (suggested)

A typical "premium bake" pipeline looks like:

1. Foreground cutout (RMBG, SAM refine)
2. Novel-view synthesis (e.g., Zero123 / Stable Zero123)
3. Depth per view (Depth Anything)
4. Fuse points to a cloud (known camera poses)
5. Reconstruct mesh (e.g., Poisson)
6. Lowpoly decimate + export (GLB/glTF)
7. Runtime optimizations (gltfpack, texture quantization)

In this scaffold, the worker is stubbed so you can validate the end-to-end job flow first.
