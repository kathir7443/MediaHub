import { Router, type IRouter, type Request, type Response } from "express";
import { spawn } from "child_process";
import { createWriteStream, unlink } from "fs";
import { mkdtemp } from "fs/promises";
import os from "os";
import path from "path";
import { FetchMediaInfoBody } from "@workspace/api-zod";

const router: IRouter = Router();

const YT_DLP_PATH = path.resolve(
  process.cwd().endsWith(path.join("artifacts", "api-server"))
    ? path.resolve(process.cwd(), "../..")
    : process.cwd(),
  ".pythonlibs/bin/yt-dlp"
);

const FFMPEG_PATH = "/nix/store/krp1xgk77d2wgh49vavxv25bcb10m88z-replit-runtime-path/bin/ffmpeg";

// ---------------------------------------------------------------------------
// In-memory metadata cache with TTL
// ---------------------------------------------------------------------------
interface CacheEntry {
  data: unknown;
  expiresAt: number;
}
const metaCache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

function cacheGet(key: string): unknown | null {
  const entry = metaCache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    metaCache.delete(key);
    return null;
  }
  return entry.data;
}

function cacheSet(key: string, data: unknown): void {
  metaCache.set(key, { data, expiresAt: Date.now() + CACHE_TTL_MS });
  // Evict oldest entries if cache grows large
  if (metaCache.size > 200) {
    const first = metaCache.keys().next().value;
    if (first) metaCache.delete(first);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function detectPlatform(url: string): "youtube" | "instagram" | "unknown" {
  if (/youtube\.com|youtu\.be/i.test(url)) return "youtube";
  if (/instagram\.com/i.test(url)) return "instagram";
  return "unknown";
}

function formatUploadDate(raw: string | null | undefined): string | null {
  if (!raw) return null;
  if (raw.length === 8) {
    return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
  }
  return raw;
}

function estimateAudioSize(durationSec: number, bitrateKbps: number): number {
  return Math.round((bitrateKbps * 1000 * durationSec) / 8);
}

function runYtDlp(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(YT_DLP_PATH, args, { timeout: 45_000 });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    proc.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    proc.on("close", (code) => {
      if (code === 0) {
        resolve(stdout.trim());
      } else {
        reject(new Error(stderr.slice(-2000) || `yt-dlp exited with code ${code}`));
      }
    });
    proc.on("error", reject);
  });
}

type RawFormat = Record<string, unknown>;

function isVideoOnly(fmt: RawFormat): boolean {
  const vcodec = fmt["vcodec"] as string | undefined;
  const acodec = fmt["acodec"] as string | undefined;
  return !!vcodec && vcodec !== "none" && (!acodec || acodec === "none");
}

function isMuxed(fmt: RawFormat): boolean {
  const vcodec = fmt["vcodec"] as string | undefined;
  const acodec = fmt["acodec"] as string | undefined;
  return !!vcodec && vcodec !== "none" && !!acodec && acodec !== "none";
}

function isAudioOnly(fmt: RawFormat): boolean {
  const vcodec = fmt["vcodec"] as string | undefined;
  const acodec = fmt["acodec"] as string | undefined;
  return (!vcodec || vcodec === "none") && !!acodec && acodec !== "none";
}

function shortCodec(codec: string | undefined | null): string | null {
  if (!codec || codec === "none") return null;
  const base = codec.split(".")[0].toLowerCase();
  const map: Record<string, string> = {
    avc1: "h264", avc: "h264", h264: "h264",
    vp09: "vp9", vp9: "vp9",
    av01: "av1", av1: "av1",
    hvc1: "h265", hevc: "h265",
    mp4a: "aac", mp4: "aac",
    opus: "opus",
    vorbis: "vorbis",
  };
  return map[base] ?? base;
}

function deleteSilently(filePath: string): void {
  unlink(filePath, () => { /* ignore */ });
}

// ---------------------------------------------------------------------------
// POST /media/info — fetch metadata + available formats
// ---------------------------------------------------------------------------
router.post("/media/info", async (req: Request, res: Response): Promise<void> => {
  const t0 = Date.now();

  const parsed = FetchMediaInfoBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request: url is required" });
    return;
  }

  const { url } = parsed.data;
  const platform = detectPlatform(url);

  if (platform === "unknown") {
    res.status(422).json({ error: "Unsupported platform. Only YouTube and Instagram URLs are supported." });
    return;
  }

  // Serve from cache if available
  const cached = cacheGet(url);
  if (cached) {
    req.log.info({ url, latencyMs: Date.now() - t0 }, "media/info: served from cache");
    res.json(cached);
    return;
  }

  try {
    const t1 = Date.now();
    const jsonOut = await runYtDlp([
      "--dump-json",
      "--no-playlist",
      "--no-warnings",
      "--no-check-certificate",
      "--socket-timeout", "10",
      url,
    ]);
    req.log.info({ url, fetchMs: Date.now() - t1 }, "media/info: yt-dlp metadata fetched");

    const t2 = Date.now();
    let info: RawFormat;
    try {
      info = JSON.parse(jsonOut) as RawFormat;
    } catch {
      res.status(422).json({ error: "Could not parse media info. The URL may be invalid or private." });
      return;
    }

    const title = (info["title"] as string) || "Unknown Title";
    const thumbnail = (info["thumbnail"] as string) || "";
    const duration = (info["duration"] as number) || 0;
    const channel = (info["uploader"] as string) || (info["channel"] as string) || "Unknown";
    const uploadDate = formatUploadDate(info["upload_date"] as string | undefined);
    const rawFormats = (info["formats"] as RawFormat[]) || [];

    // --- Video formats (muxed + video-only) ---
    const videoFormats: {
      formatId: string;
      quality: string;
      height: number | null;
      width: number | null;
      ext: string;
      filesize: number | null;
      fps: number | null;
      vcodec: string | null;
      acodec: string | null;
      needsMerge: boolean;
      tbr: number | null;
    }[] = [];

    for (const fmt of rawFormats) {
      const height = fmt["height"] as number | undefined;
      const vcodec = fmt["vcodec"] as string | undefined;
      if (!vcodec || vcodec === "none" || !height || height < 100) continue;
      const formatNote = (fmt["format_note"] as string | undefined) ?? "";
      if (/storyboard|premium/i.test(formatNote)) continue;

      const ext = (fmt["ext"] as string) || "mp4";
      const formatId = fmt["format_id"] as string;
      const acodec = fmt["acodec"] as string | undefined;
      const needsMerge = isVideoOnly(fmt);

      videoFormats.push({
        formatId,
        quality: `${height}p`,
        height: height ?? null,
        width: (fmt["width"] as number | null) ?? null,
        ext: needsMerge ? "mp4" : (ext === "webm" ? "webm" : "mp4"),
        filesize:
          (fmt["filesize"] as number | null) ??
          (fmt["filesize_approx"] as number | null) ??
          null,
        fps: (fmt["fps"] as number | null) ?? null,
        vcodec: shortCodec(vcodec),
        acodec: isMuxed(fmt) ? shortCodec(acodec) : null,
        needsMerge,
        tbr: (fmt["tbr"] as number | null) ?? null,
      });
    }

    videoFormats.sort((a, b) => {
      const hDiff = (b.height ?? 0) - (a.height ?? 0);
      return hDiff !== 0 ? hDiff : (b.tbr ?? 0) - (a.tbr ?? 0);
    });

    // --- Audio formats ---
    const audioFormats: {
      formatId: string;
      label: string;
      ext: string;
      filesize: number | null;
      abr: number | null;
      acodec: string | null;
      isConversion: boolean;
      conversionAbr: number | null;
    }[] = [];

    for (const abr of [320, 192, 128]) {
      audioFormats.push({
        formatId: `mp3-${abr}`,
        label: `MP3 ${abr}kbps`,
        ext: "mp3",
        filesize: duration > 0 ? estimateAudioSize(duration, abr) : null,
        abr,
        acodec: "mp3",
        isConversion: true,
        conversionAbr: abr,
      });
    }

    const audioOnlyFormats = rawFormats
      .filter(isAudioOnly)
      .sort((a, b) => ((b["abr"] as number) || 0) - ((a["abr"] as number) || 0));

    for (const fmt of audioOnlyFormats) {
      const abr = (fmt["abr"] as number | null) ?? null;
      const ext = (fmt["ext"] as string) || "m4a";
      const acodec = shortCodec(fmt["acodec"] as string | undefined);
      const label = abr
        ? `Original ${ext.toUpperCase()} (${Math.round(abr)}kbps)`
        : `Original ${ext.toUpperCase()}`;

      audioFormats.push({
        formatId: fmt["format_id"] as string,
        label,
        ext,
        filesize:
          (fmt["filesize"] as number | null) ??
          (fmt["filesize_approx"] as number | null) ??
          (duration > 0 && abr ? estimateAudioSize(duration, abr) : null),
        abr,
        acodec,
        isConversion: false,
        conversionAbr: null,
      });
    }

    req.log.info({
      url,
      extractMs: Date.now() - t2,
      totalMs: Date.now() - t0,
      videoFormats: videoFormats.length,
      audioFormats: audioFormats.length,
    }, "media/info: format extraction complete");

    const payload = { title, thumbnail, duration, channel, uploadDate, platform, videoFormats, audioFormats };
    cacheSet(url, payload);
    res.json(payload);

  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    req.log.error({ err, url, totalMs: Date.now() - t0 }, "media/info: failed");

    if (/private|members.only/i.test(message)) {
      res.status(422).json({ error: "This content is private and cannot be accessed." });
      return;
    }
    if (/sign in|not a bot|confirm.*age/i.test(message)) {
      res.status(422).json({ error: "YouTube requires authentication for this content." });
      return;
    }
    if (/video unavailable|no video/i.test(message)) {
      res.status(422).json({ error: "This video is unavailable." });
      return;
    }
    res.status(422).json({ error: "Failed to fetch media info. Please check the URL and try again." });
  }
});

// ---------------------------------------------------------------------------
// GET /media/download — stream media directly to browser
// ---------------------------------------------------------------------------
router.get("/media/download", async (req: Request, res: Response): Promise<void> => {
  const t0 = Date.now();

  const rawUrl = req.query["url"] as string | undefined;
  const formatId = req.query["formatId"] as string | undefined;
  const needsMerge = req.query["needsMerge"] === "true";
  const isConversion = req.query["isConversion"] === "true";
  const conversionAbrStr = req.query["conversionAbr"] as string | undefined;
  const ext = (req.query["ext"] as string | undefined) || "mp4";
  const fileSizeStr = req.query["filesize"] as string | undefined;
  const title = (req.query["title"] as string | undefined) || "media";
  const safeTitle = title.replace(/[^a-z0-9_\-. ]/gi, "_").slice(0, 80);

  if (!rawUrl) {
    res.status(400).json({ error: "url query param is required" });
    return;
  }

  // Set Content-Length when we have an accurate size estimate
  const knownSize = fileSizeStr ? parseInt(fileSizeStr, 10) : NaN;
  if (!isNaN(knownSize) && knownSize > 0 && !needsMerge && !isConversion) {
    res.setHeader("Content-Length", knownSize);
  }

  // Disable proxy buffering so bytes flow immediately to the client
  res.setHeader("X-Accel-Buffering", "no");
  res.setHeader("Cache-Control", "no-store");

  req.log.info({ url: rawUrl, formatId, needsMerge, isConversion, ext }, "download: start");

  // ── MP3 conversion ────────────────────────────────────────────────────────
  if (isConversion) {
    const abr = conversionAbrStr ? parseInt(conversionAbrStr, 10) : 192;

    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Content-Disposition", `attachment; filename="${safeTitle}_${abr}kbps.mp3"`);

    const args = [
      "--ffmpeg-location", FFMPEG_PATH,
      "-f", "bestaudio/best",
      "--extract-audio",
      "--audio-format", "mp3",
      "--audio-quality", `${abr}K`,
      "--no-part",
      "--no-warnings",
      "--no-check-certificate",
      "--concurrent-fragments", "4",
      "-o", "-",
      rawUrl,
    ];

    const proc = spawn(YT_DLP_PATH, args);
    proc.stdout.pipe(res);
    proc.stderr.on("data", (c: Buffer) => req.log.debug({ msg: c.toString().slice(-300) }, "yt-dlp stderr"));
    proc.on("close", (code) => {
      req.log.info({ code, totalMs: Date.now() - t0 }, "download: MP3 conversion done");
    });
    proc.on("error", (err) => {
      req.log.error({ err }, "download: process error");
      if (!res.headersSent) res.status(500).json({ error: "Download failed" });
    });
    return;
  }

  if (!formatId) {
    res.status(400).json({ error: "formatId is required" });
    return;
  }

  // ── Merged download (video-only + bestaudio → mp4 via FFmpeg) ─────────────
  // yt-dlp can't pipe a merged output reliably across all versions, so we
  // write to a temp file then stream it. The temp file is deleted immediately
  // after the response completes to minimise disk residency.
  if (needsMerge) {
    let tmpDir: string | null = null;
    let tmpFile: string | null = null;

    try {
      tmpDir = await mkdtemp(path.join(os.tmpdir(), "mediahub-"));
      tmpFile = path.join(tmpDir, `${Date.now()}.mp4`);

      const tMerge = Date.now();
      req.log.info({ formatId, tmpFile }, "download: merging streams to tmp");

      const args = [
        "--ffmpeg-location", FFMPEG_PATH,
        "-f", `${formatId}+bestaudio/best`,
        "--merge-output-format", "mp4",
        // Copy streams without re-encoding — fastest possible merge
        "--postprocessor-args", "ffmpeg:-c copy",
        "--no-part",
        "--no-warnings",
        "--no-check-certificate",
        "--concurrent-fragments", "4",
        "-o", tmpFile,
        rawUrl,
      ];

      await runYtDlp(args);
      req.log.info({ mergeMs: Date.now() - tMerge }, "download: merge complete");

      // Determine actual size for Content-Length
      const { statSync } = await import("fs");
      let fileSize: number | null = null;
      try { fileSize = statSync(tmpFile).size; } catch { /* ignore */ }
      if (fileSize) res.setHeader("Content-Length", fileSize);

      res.setHeader("Content-Type", "video/mp4");
      res.setHeader("Content-Disposition", `attachment; filename="${safeTitle}.mp4"`);

      const { createReadStream } = await import("fs");
      const stream = createReadStream(tmpFile, { highWaterMark: 256 * 1024 });
      stream.pipe(res);

      res.on("finish", () => {
        req.log.info({ totalMs: Date.now() - t0 }, "download: merge stream sent");
        if (tmpFile) deleteSilently(tmpFile);
        if (tmpDir) deleteSilently(tmpDir);
      });

      res.on("close", () => {
        if (tmpFile) deleteSilently(tmpFile);
        if (tmpDir) deleteSilently(tmpDir);
      });

    } catch (err) {
      req.log.error({ err, totalMs: Date.now() - t0 }, "download: merge failed");
      if (tmpFile) deleteSilently(tmpFile);
      if (tmpDir) deleteSilently(tmpDir);
      if (!res.headersSent) res.status(500).json({ error: "Merge failed. Please try a lower quality." });
    }
    return;
  }

  // ── Direct streaming (muxed or audio-only — no FFmpeg needed) ────────────
  const isAudioExt = ["m4a", "opus", "webm", "ogg", "aac"].includes(ext);
  res.setHeader("Content-Type", isAudioExt ? "audio/mp4" : "video/mp4");
  res.setHeader("Content-Disposition", `attachment; filename="${safeTitle}.${ext}"`);

  const args = [
    "--ffmpeg-location", FFMPEG_PATH,
    "-f", formatId,
    "--no-part",
    "--no-warnings",
    "--no-check-certificate",
    "--concurrent-fragments", "4",
    "--buffer-size", "16K",
    "-o", "-",
    rawUrl,
  ];

  const tStream = Date.now();
  const proc = spawn(YT_DLP_PATH, args);
  proc.stdout.pipe(res);
  proc.stderr.on("data", (c: Buffer) => req.log.debug({ msg: c.toString().slice(-300) }, "yt-dlp stderr"));
  proc.on("close", (code) => {
    req.log.info({ code, streamMs: Date.now() - tStream, totalMs: Date.now() - t0 }, "download: direct stream done");
  });
  proc.on("error", (err) => {
    req.log.error({ err }, "download: process error");
    if (!res.headersSent) res.status(500).json({ error: "Download failed" });
  });
});

export default router;
