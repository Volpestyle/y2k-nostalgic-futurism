# pipeline-core

Shared pipeline interfaces and runner abstractions for the holo bake pipeline.

## Local runners

`pipeline_core.local_runners` provides a default local implementation for cutout/depth and placeholder
implementations for the other stages. It expects `torch`, `transformers`, `numpy`, and `Pillow`.

## Remote runner contract

The `RemoteStageRunner` expects an HTTP endpoint at:

```
POST /v1/pipeline/run
```

Payload:

```json
{
  "stage": "cutout",
  "input": { "uri": "s3://bucket/input.png", "mediaType": "image/png" },
  "output": { "uri": "s3://bucket/output.png", "mediaType": "image/png" },
  "config": {},
  "metadata": {}
}
```

Response:

```json
{
  "output": { "uri": "s3://bucket/output.png", "mediaType": "image/png" },
  "metadata": {}
}
```
