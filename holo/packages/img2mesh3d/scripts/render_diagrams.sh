#!/usr/bin/env bash
set -euo pipefail

# Requires Node.js.
# This uses npx to run mermaid-cli without installing globally.
# If you are in a pnpm monorepo, feel free to replace with pnpm dlx.

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIAG_DIR="$ROOT/docs/diagrams"

mkdir -p "$DIAG_DIR"

npx -y @mermaid-js/mermaid-cli@latest -i "$DIAG_DIR/pipeline.mmd" -o "$DIAG_DIR/pipeline.png"
npx -y @mermaid-js/mermaid-cli@latest -i "$DIAG_DIR/aws.mmd" -o "$DIAG_DIR/aws.png"

echo "Rendered diagrams to $DIAG_DIR"
