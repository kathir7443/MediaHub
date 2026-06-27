# MediaHub

A production-ready media downloader that extracts YouTube and Instagram videos/audio using yt-dlp and FFmpeg, with a dark glassmorphism React UI.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 5000)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run typecheck:libs` — build and typecheck shared libs only
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5 + yt-dlp + FFmpeg
- Frontend: React + Vite + Tailwind CSS + shadcn/ui
- Validation: Zod (`zod/v4`)
- API contract: OpenAPI 3.1 → Orval codegen (React Query hooks + Zod schemas)
- Build: esbuild (ESM bundle)

## Where things live

- `lib/api-spec/openapi.yaml` — source of truth for all API contracts
- `lib/api-zod/src/generated/` — Zod schemas generated from OpenAPI
- `lib/api-client-react/src/generated/` — React Query hooks generated from OpenAPI
- `artifacts/api-server/src/routes/media.ts` — yt-dlp + FFmpeg download logic
- `artifacts/mediahub/src/` — React frontend

## Architecture decisions

- Binary detection at startup via `which` (PATH-based), with `YT_DLP_PATH` / `FFMPEG_PATH` / `FFPROBE_PATH` env var overrides. No hardcoded paths.
- Frontend API base URL controlled by `VITE_API_BASE_URL` env var (`setBaseUrl` in `main.tsx`). Empty → relative `/api/...` paths (same-origin / Replit proxy).
- No database — MediaHub is stateless. `@workspace/db` is not a dependency of the API server.
- CORS origin controlled by `CORS_ORIGIN` env var (comma-separated). Unset → allow all (suitable for dev).
- No-timeout merge path in yt-dlp for long video+audio merges to avoid truncated downloads.

## Deployment

### Render (API backend)

1. Create a new **Web Service** on Render pointing at this GitHub repo.
2. Set **Build Command**: `bash scripts/render-build.sh`
3. Set **Start Command**: `node artifacts/api-server/dist/index.mjs`
4. Set env vars:
   - `NODE_ENV=production`
   - `PORT=10000` (Render sets this automatically)
   - `CORS_ORIGIN=https://your-mediahub.vercel.app` (your Vercel frontend URL)
5. Render installs ffmpeg and yt-dlp during the build step — no manual setup needed.

Or use the `render.yaml` Blueprint in this repo.

### Vercel (frontend)

1. Import this GitHub repo into Vercel.
2. Vercel picks up `vercel.json` automatically — no manual framework config needed.
3. Add env var: `VITE_API_BASE_URL=https://your-mediahub-api.onrender.com`
4. Deploy.

### Local dev

```bash
# Install yt-dlp and ffmpeg via your package manager, then:
pnpm install
pnpm --filter @workspace/api-server run dev   # API on :5000
pnpm --filter @workspace/mediahub run dev      # Frontend on :5173
```

See `.env.example` files in `artifacts/api-server/` and `artifacts/mediahub/` for required variables.

## Product

- Paste a YouTube or Instagram URL → MediaHub fetches all available video and audio formats
- Choose quality (144p–4K), download as MP4 (direct stream or merged) or MP3 (converted)
- Dark glassmorphism UI, Safari-compatible, mobile-friendly

## Gotchas

- Always run `pnpm --filter @workspace/api-spec run codegen` after editing `lib/api-spec/openapi.yaml` — generated files are committed.
- Do not run `pnpm dev` at the workspace root — run per-artifact with `--filter`.
- The `pnpm-workspace.yaml` esbuild overrides install only the `linux-x64` binary. If deploying to an arm64 host, remove the `linux-arm64` exclusion from `pnpm-workspace.yaml`.
- `ENOENT` errors from the API (HTTP 503) mean yt-dlp is not installed on the server. The Render build script installs it automatically.

## User preferences

_Populate as you build — explicit user instructions worth remembering across sessions._

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
