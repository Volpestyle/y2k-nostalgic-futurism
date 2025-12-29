#!/usr/bin/env bash
set -euo pipefail

# Render Mermaid .mmd files in ./docs/diagrams into PNGs in ./docs/images.
#
# Recommended (Docker) because it bundles Chromium:
#   docker run --rm -u "$(id -u):$(id -g)" \
#     -v "$PWD:/work" \
#     minlag/mermaid-cli \
#     -i /work/docs/diagrams/01-system-context.mmd \
#     -o /work/docs/images/01-system-context.png \
#     -b transparent
#
# If you prefer Node:
#   pnpm -w dlx @mermaid-js/mermaid-cli -i docs/diagrams/01-system-context.mmd -o docs/images/01-system-context.png

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
IN_DIR="$ROOT_DIR/docs/diagrams"
OUT_DIR="$ROOT_DIR/docs/images"

mkdir -p "$OUT_DIR"

if command -v docker >/dev/null 2>&1; then
  for f in "$IN_DIR"/*.mmd; do
    base=$(basename "$f" .mmd)
    docker run --rm -u "$(id -u):$(id -g)" \
      -v "$ROOT_DIR:/work" \
      minlag/mermaid-cli \
      -i "/work/docs/diagrams/${base}.mmd" \
      -o "/work/docs/images/${base}.png" \
      -b transparent
    echo "rendered ${base}.png"
  done
else
  echo "Docker not found. Try: pnpm -w dlx @mermaid-js/mermaid-cli ..." >&2
  exit 1
fi
