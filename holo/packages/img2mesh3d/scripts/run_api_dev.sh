#!/usr/bin/env bash
set -euo pipefail

# Requires: pip install -e ".[api]"
export PYTHONPATH=src
uvicorn img2mesh3d.api.app:app --reload --host 0.0.0.0 --port 8000
