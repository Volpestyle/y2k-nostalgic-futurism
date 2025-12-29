#!/usr/bin/env bash
set -euo pipefail

# Preferred: render Mermaid source (*.mmd) to PNGs.
# Option A: via Docker (no local node needed)
#   docker run --rm -u "$(id -u):$(id -g)" -v "$PWD:/data" minlag/mermaid-cli \
#     -i /data/docs/diagrams/01-system-context.mmd -o /data/docs/images/01-system-context.png -b transparent
#
# Option B: via npx (requires Node + network)
#   npx -y @mermaid-js/mermaid-cli -i docs/diagrams/01-system-context.mmd -o docs/images/01-system-context.png

echo "See comments in this file for Docker / npx commands."
exit 0
