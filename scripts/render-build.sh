#!/usr/bin/env bash
# Build script for Render web service deployments.
# Set this as the "Build Command" in your Render service settings:
#   bash scripts/render-build.sh
set -euo pipefail

echo "=== [1/5] Installing ffmpeg ==="
apt-get update -qq
apt-get install -y --no-install-recommends ffmpeg
echo "ffmpeg: $(ffmpeg -version 2>&1 | head -1)"

echo "=== [2/5] Installing yt-dlp (standalone binary) ==="
curl -fsSL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp \
  -o /usr/local/bin/yt-dlp
chmod a+rx /usr/local/bin/yt-dlp
echo "yt-dlp: $(yt-dlp --version)"

echo "=== [3/5] Installing pnpm ==="
npm install -g pnpm
echo "pnpm: $(pnpm --version)"

echo "=== [4/5] Installing Node.js dependencies ==="
pnpm install --frozen-lockfile

echo "=== [5/5] Building API server ==="
pnpm run typecheck:libs
pnpm --filter @workspace/api-server run build

echo "=== Build complete ==="
