#!/usr/bin/env bash
# Idempotent dependency refresh for the qq-music-xiaozhi local service.
# The ESP-IDF firmware toolchain lives in the base image (.cursor/Dockerfile);
# its per-project managed components are fetched on demand by `idf.py build`.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT/qq-music-xiaozhi"

# Node dependencies: QQ Music HTTP API, local MCP server, music proxy.
npm ci

# Python venv for the Xiaozhi MCP pipe (mcp/mcp_pipe.py).
python3 -m venv .venv
./.venv/bin/python -m pip install --quiet --upgrade pip
./.venv/bin/python -m pip install --quiet -r mcp/requirements.txt

echo "install.sh: qq-music-xiaozhi dependencies ready"
