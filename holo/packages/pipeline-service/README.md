# pipeline-service

Minimal HTTP service that runs a single pipeline stage per request.

## Run locally

```bash
cd packages/pipeline-service
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn server:app --host 0.0.0.0 --port 9090
```

Then point the worker at it (overriding auto mode):

```bash
export HOLO_PIPELINE_RUNNER=remote
export HOLO_PIPELINE_REMOTE_URL=http://localhost:9090
```
