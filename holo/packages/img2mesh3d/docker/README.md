# Docker

## API

```bash
docker build -f docker/api.Dockerfile -t img2mesh3d-api .
docker run --rm -p 8080:8080 \
  -e IMG2MESH3D_QUEUE_URL=... \
  -e IMG2MESH3D_DDB_TABLE=... \
  -e IMG2MESH3D_S3_BUCKET=... \
  -e REPLICATE_API_TOKEN=... \
  -e MESHY_API_KEY=... \
  img2mesh3d-api
```

## Worker

```bash
docker build -f docker/worker.Dockerfile -t img2mesh3d-worker .
docker run --rm \
  -e IMG2MESH3D_QUEUE_URL=... \
  -e IMG2MESH3D_DDB_TABLE=... \
  -e IMG2MESH3D_S3_BUCKET=... \
  -e REPLICATE_API_TOKEN=... \
  -e MESHY_API_KEY=... \
  img2mesh3d-worker
```

In AWS you would normally deploy these as ECS/Fargate services with IAM task roles.
