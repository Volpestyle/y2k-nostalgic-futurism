#!/usr/bin/env bash
set -euo pipefail

# Generates PNG diagrams from Mermaid files.
# Requires Node.js. Uses npx so you don't need a global install.
#
# In a pnpm monorepo, you can add @mermaid-js/mermaid-cli as a devDependency and run it from there.

npx -y @mermaid-js/mermaid-cli -i docs/diagrams/pipeline.mmd -o docs/diagrams/pipeline.png
echo "✅ diagrams rendered"
