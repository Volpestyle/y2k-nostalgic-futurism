# Overview

This repo separates **traffic-handling** from **GPU baking**:

- **Go API (`packages/api-go`)** handles HTTP, auth (later), rate limiting (later), job state, and returning URLs.
- **Python worker (`packages/worker-py`)** runs the compute-heavy pipeline stages.
- **BakeSpec (`packages/shared-spec`)** is a versioned JSON contract shared by all apps/services.

Why this shape?

- The client API stays stable while you swap implementations:
  - local: filesystem + sqlite + local worker process
  - cloud: S3 + SQS + Batch/SageMaker GPU jobs

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
