#!/usr/bin/env bash
set -euo pipefail

if [[ "${OSTYPE:-}" != darwin* ]]; then
  echo "Dalil installer supports macOS only."
  exit 1
fi

if [[ "$(uname -m)" != "arm64" ]]; then
  echo "Dalil installer supports Apple Silicon (arm64) only."
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 20+ is required."
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "npm is required."
  exit 1
fi

NODE_MAJOR="$(node -p "process.versions.node.split('.')[0]")"
if [[ "${NODE_MAJOR}" -lt 20 ]]; then
  echo "Node.js 20+ is required. Current: $(node -v)"
  exit 1
fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VERSION="$(node -p "require('${ROOT_DIR}/package.json').version")"
INSTALL_ROOT="${DALIL_INSTALL_ROOT:-$HOME/.local/share/dalil}"
BIN_DIR="${DALIL_BIN_DIR:-$HOME/.local/bin}"
TARGET_DIR="${INSTALL_ROOT}/${VERSION}"

mkdir -p "${TARGET_DIR}" "${BIN_DIR}"

rsync -a --delete \
  --exclude ".DS_Store" \
  --exclude "install.sh" \
  "${ROOT_DIR}/" "${TARGET_DIR}/"

cd "${TARGET_DIR}"
npm ci --omit=dev
npx playwright install chromium

chmod +x "${TARGET_DIR}/dist/main.js"
ln -sf "${TARGET_DIR}/dist/main.js" "${BIN_DIR}/dalil"

echo "Installed: ${BIN_DIR}/dalil"
if ! echo ":${PATH}:" | grep -q ":${BIN_DIR}:"; then
  echo "Add ${BIN_DIR} to PATH:"
  echo "  export PATH=\"${BIN_DIR}:\$PATH\""
fi
