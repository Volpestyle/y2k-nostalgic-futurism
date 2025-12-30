#!/usr/bin/env bash
set -euo pipefail
IMG2MESH3D_LOCAL_MODE=1 uvicorn img2mesh3d.api.app:app --host 0.0.0.0 --port 8080 --reload
