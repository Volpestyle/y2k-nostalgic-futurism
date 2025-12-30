# Deployment (AWS)

This scaffold is designed so you can swap local adapters for AWS-managed building blocks:

- Blob store: Local FS → **S3**
- Job state: SQLite → **DynamoDB** (or RDS)
- Queue: DB polling → **SQS**
- Worker: local process → **AWS Batch (GPU jobs)** or **SageMaker async inference**
- Notifications: local SSE → **WebSocket API** or **SNS**

## Suggested "scale-to-zero" shape

1) Client uploads input to S3 via pre-signed URL.
2) img2mesh3d API enqueues a job (SQS) and stores spec/state (DynamoDB).
3) Batch compute environment spins up GPU instance(s) only when jobs exist.
4) Worker writes outputs back to S3.
5) Client polls status or listens for completion.

## Keeping the contract stable

Treat `BakeSpec` as an API contract:

- versions live in `packages/shared-spec`
- all workers must accept a BakeSpec JSON
- all outputs should be written in predictable locations (jobId-based)

## Checklist

- [ ] Containerize `packages/img2mesh3d` API
- [ ] Containerize the `img2mesh3d-worker`
- [ ] Add auth + rate limiting
- [ ] Add observability (structured logs, traces, metrics)
