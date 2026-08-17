#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
USER_BIN_DIR="${BONSAI_BIN_DIR:-$(cd ~ && pwd)/.local/bin}"

mkdir -p "$USER_BIN_DIR"
ln -sfn "$REPO_ROOT/scripts/bonsai" "$USER_BIN_DIR/Bonsai"
printf 'Installed Bonsai -> %s\n' "$REPO_ROOT"
