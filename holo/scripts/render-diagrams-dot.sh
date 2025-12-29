#!/usr/bin/env bash
set -euo pipefail

# Offline fallback: renders ./docs/diagrams-dot/*.dot to ./docs/images/*.png
# Requires graphviz (`dot`) installed.

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
DOT_DIR="$ROOT_DIR/docs/diagrams-dot"
IMG_DIR="$ROOT_DIR/docs/images"

mkdir -p "$IMG_DIR"

for f in "$DOT_DIR"/*.dot; do
  name=$(basename "$f" .dot)
  dot -Tpng "$f" -o "$IMG_DIR/$name.png"
  echo "rendered $name.png"
done
