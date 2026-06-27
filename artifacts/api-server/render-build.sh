#!/usr/bin/env bash

set -e

pip3 install yt-dlp

pnpm install --no-frozen-lockfile
pnpm --filter @workspace/api-server build
