import { Router, type IRouter, type Request, type Response } from "express";
import { spawn, type ChildProcess } from "child_process";
import { createReadStream, statSync, unlink, mkdirSync } from "fs";
import { rm } from "fs/promises";
import os from "os";
import path from "path";
import { FetchMediaInfoBody } from "@workspace/api-zod";

const router: IRouter = Router();

const YT_DLP_PATH = "yt-dlp";
const FFMPEG_PATH = "ffmpeg";
const FFPROBE_PATH = "ffprobe";
// ---------------------------------------------------------------------------
// In-memory metadata cache (5-minute TTL)
// ---------------------------------------------------------------------------
interface CacheEntry { data: unknown; expiresAt: number; }
const metaCache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 5 * 60 * 1000;

function cacheGet(key: string): unknown | null {
  const e = metaCache.get(key);
  if (!e) return null;
  if (Date.now() > e.expiresAt) { metaCache.delete(key); return null; }
  return e.data;
}
function cacheSet(key: string, data: unknown): void {
  metaCache.set(key, { data, expiresAt: Date.now() + CACHE_TTL_MS });
  if (metaCache.size > 200) {
    const first = metaCache.keys().next().value;
    if (first) metaCache.delete(first);
  }
}

// ---------------------------------------------------------------------------
// Process helpers
// ---------------------------------------------------------------------------

/** Run yt-dlp collecting stdout. Used for metadata only (45 s timeout is fine). */
function runYtDlp(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(YT_DLP_PATH, args, { timeout: 45_000 });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (c: Buffer) => { stdout += c.toString(); });
    proc.stderr.on("data", (c: Buffer) => { stderr += c.toString(); });
    proc.on("close", (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(stderr.slice(-2000) || `yt-dlp exited with code ${code}`));
    });
    proc.on("error", reject);
  });
}

/**
 * Run yt-dlp writing a file (merge path).  NO timeout — merging a large video
 * can take many minutes and a timeout would SIGTERM the process mid-write,
 * producing a truncated / corrupt output file.
 */
function runYtDlpFile(args: string[], logLabel: string): Promise<void> {
  return new Promise((resolve, reject) => {
    // Log the exact command so we can reproduce any failure
    const cmd = [YT_DLP_PATH, ...args].join(" ");
    process.stdout.write(`[mediahub] ${logLabel}: ${cmd}\n`);

    // No { timeout } option here — this is intentional
    const proc: ChildProcess = spawn(YT_DLP_PATH, args);
    let stderr = "";
    proc.stdout?.on("data", () => { /* yt-dlp writing to file; stdout should be empty */ });
    proc.stderr?.on("data", (c: Buffer) => {
      const chunk = c.toString();
      stderr += chunk;
      // Stream stderr to server log in real time so we see FFmpeg progress
      process.stdout.write(`[yt-dlp] ${chunk}`);
    });
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`yt-dlp exited ${code}: ${stderr.slice(-1000)}`));
    });
    proc.on("error", reject);
  });
}

/** Run ffprobe to verify a file is a valid, seekable MP4. */
function verifyMp4(filePath: string): Promise<{ ok: boolean; report: string }> {
  return new Promise((resolve) => {
    const args = [
      "-v", "error",
      "-show_entries", "format=format_name,duration,size:stream=codec_type,codec_name",
      "-of", "default=noprint_wrappers=1",
      filePath,
    ];
    const proc = spawn(FFPROBE_PATH, args, { timeout: 15_000 });
    let out = "";
    let err = "";
    proc.stdout.on("data", (c: Buffer) => { out += c.toString(); });
    proc.stderr.on("data", (c: Buffer) => { err += c.toString(); });
    proc.on("close", (code) => {
      resolve({ ok: code === 0, report: out || err });
    });
    proc.on("error", (e) => resolve({ ok: false, report: e.message }));
  });
}

// ---------------------------------------------------------------------------
// Domain helpers
// ---------------------------------------------------------------------------
type RawFormat = Record<string, unknown>;

function detectPlatform(url: string): "youtube" | "instagram" | "unknown" {
  if (/youtube\.com|youtu\.be/i.test(url)) return "youtube";
  if (/instagram\.com/i.test(url)) return "instagram";
  return "unknown";
}
function formatUploadDate(raw: string | null | undefined): string | null {
  if (!raw) return null;
  if (raw.length === 8) return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
  return raw;
}
function estimateAudioSize(dur: number, kbps: number): number {
  return Math.round((kbps * 1000 * dur) / 8);
}
function isVideoOnly(f: RawFormat): boolean {
  const vc = f["vcodec"] as string | undefined;
  const ac = f["acodec"] as string | undefined;
  return !!vc && vc !== "none" && (!ac || ac === "none");
}
function isMuxed(f: RawFormat): boolean {
  const vc = f["vcodec"] as string | undefined;
  const ac = f["acodec"] as string | undefined;
  return !!vc && vc !== "none" && !!ac && ac !== "none";
}
function isAudioOnly(f: RawFormat): boolean {
  const vc = f["vcodec"] as string | undefined;
  const ac = f["acodec"] as string | undefined;
  return (!vc || vc === "none") && !!ac && ac !== "none";
}
function shortCodec(c: string | null | undefined): string | null {
  if (!c || c === "none") return null;
  const base = c.split(".")[0].toLowerCase();
  const m: Record<string, string> = {
    avc1: "h264", avc: "h264", h264: "h264",
    vp09: "vp9", vp9: "vp9",
    av01: "av1", av1: "av1",
    hvc1: "h265", hevc: "h265",
    mp4a: "aac", mp4: "aac",
    opus: "opus", vorbis: "vorbis",
  };
  return m[base] ?? base;
}

function deleteSilently(p: string): void { unlink(p, () => {}); }
async function deleteDirSilently(p: string): Promise<void> {
  try { await rm(p, { recursive: true, force: true }); } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// POST /media/info
// ---------------------------------------------------------------------------
router.post("/media/info", async (req: Request, res: Response): Promise<void> => {
  const t0 = Date.now();
  const parsed = FetchMediaInfoBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "url is required" }); return; }

  const { url } = parsed.data;
  const platform = detectPlatform(url);
  if (platform === "unknown") {
    res.status(422).json({ error: "Only YouTube and Instagram URLs are supported." });
    return;
  }

  const cached = cacheGet(url);
  if (cached) {
    req.log.info({ url, latencyMs: Date.now() - t0 }, "media/info: cache hit");
    res.json(cached);
    return;
  }

  try {
    const t1 = Date.now();
    const jsonOut = await runYtDlp([
      "--dump-json", "--no-playlist", "--no-warnings",
      "--no-check-certificate", "--socket-timeout", "10", url,
    ]);
    req.log.info({ url, fetchMs: Date.now() - t1 }, "media/info: metadata fetched");

    const t2 = Date.now();
    let info: RawFormat;
    try { info = JSON.parse(jsonOut) as RawFormat; }
    catch { res.status(422).json({ error: "Could not parse media info." }); return; }

    const title = (info["title"] as string) || "Unknown Title";
    const thumbnail = (info["thumbnail"] as string) || "";
    const duration = (info["duration"] as number) || 0;
    const channel = (info["uploader"] as string) || (info["channel"] as string) || "Unknown";
    const uploadDate = formatUploadDate(info["upload_date"] as string | undefined);
    const rawFormats = (info["formats"] as RawFormat[]) || [];

    const videoFormats: {
      formatId: string; quality: string; height: number | null; width: number | null;
      ext: string; filesize: number | null; fps: number | null;
      vcodec: string | null; acodec: string | null; needsMerge: boolean; tbr: number | null;
    }[] = [];

    for (const fmt of rawFormats) {
      const height = fmt["height"] as number | undefined;
      const vcodec = fmt["vcodec"] as string | undefined;
      if (!vcodec || vcodec === "none" || !height || height < 100) continue;
      const note = (fmt["format_note"] as string | undefined) ?? "";
      if (/storyboard|premium/i.test(note)) continue;
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
        filesize: (fmt["filesize"] as number | null) ?? (fmt["filesize_approx"] as number | null) ?? null,
        fps: (fmt["fps"] as number | null) ?? null,
        vcodec: shortCodec(vcodec),
        acodec: isMuxed(fmt) ? shortCodec(acodec) : null,
        needsMerge,
        tbr: (fmt["tbr"] as number | null) ?? null,
      });
    }
    videoFormats.sort((a, b) => {
      const hd = (b.height ?? 0) - (a.height ?? 0);
      return hd !== 0 ? hd : (b.tbr ?? 0) - (a.tbr ?? 0);
    });

    const audioFormats: {
      formatId: string; label: string; ext: string; filesize: number | null;
      abr: number | null; acodec: string | null; isConversion: boolean; conversionAbr: number | null;
    }[] = [];

    for (const abr of [320, 192, 128]) {
      audioFormats.push({
        formatId: `mp3-${abr}`, label: `MP3 ${abr}kbps`, ext: "mp3",
        filesize: duration > 0 ? estimateAudioSize(duration, abr) : null,
        abr, acodec: "mp3", isConversion: true, conversionAbr: abr,
      });
    }
    for (const fmt of rawFormats.filter(isAudioOnly).sort((a, b) => ((b["abr"] as number) || 0) - ((a["abr"] as number) || 0))) {
      const abr = (fmt["abr"] as number | null) ?? null;
      const ext = (fmt["ext"] as string) || "m4a";
      audioFormats.push({
        formatId: fmt["format_id"] as string,
        label: abr ? `Original ${ext.toUpperCase()} (${Math.round(abr)}kbps)` : `Original ${ext.toUpperCase()}`,
        ext, filesize: (fmt["filesize"] as number | null) ?? (fmt["filesize_approx"] as number | null) ?? (duration > 0 && abr ? estimateAudioSize(duration, abr) : null),
        abr, acodec: shortCodec(fmt["acodec"] as string | undefined),
        isConversion: false, conversionAbr: null,
      });
    }

    req.log.info({
      url, extractMs: Date.now() - t2, totalMs: Date.now() - t0,
      videoFormats: videoFormats.length, audioFormats: audioFormats.length,
    }, "media/info: complete");

    const payload = { title, thumbnail, duration, channel, uploadDate, platform, videoFormats, audioFormats };
    cacheSet(url, payload);
    res.json(payload);

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    req.log.error({ err, url, totalMs: Date.now() - t0 }, "media/info: failed");
    if (/private|members.only/i.test(msg)) { res.status(422).json({ error: "This content is private." }); return; }
    if (/sign in|not a bot|confirm.*age/i.test(msg)) { res.status(422).json({ error: "YouTube requires authentication." }); return; }
    if (/video unavailable|no video/i.test(msg)) { res.status(422).json({ error: "This video is unavailable." }); return; }
    res.status(422).json({ error: "Failed to fetch media info. Check the URL and try again." });
  }
});

// ---------------------------------------------------------------------------
// GET /media/download
// ---------------------------------------------------------------------------
router.get("/media/download", async (req: Request, res: Response): Promise<void> => {
  const t0 = Date.now();
  const rawUrl       = req.query["url"] as string | undefined;
  const formatId     = req.query["formatId"] as string | undefined;
  const needsMerge   = req.query["needsMerge"] === "true";
  const isConversion = req.query["isConversion"] === "true";
  const convAbrStr   = req.query["conversionAbr"] as string | undefined;
  const ext          = (req.query["ext"] as string | undefined) || "mp4";
  const fileSizeStr  = req.query["filesize"] as string | undefined;
  const title        = (req.query["title"] as string | undefined) || "media";
  const safeTitle    = title.replace(/[^a-z0-9_\-. ]/gi, "_").slice(0, 80);

  if (!rawUrl) { res.status(400).json({ error: "url is required" }); return; }

  res.setHeader("X-Accel-Buffering", "no");
  res.setHeader("Cache-Control", "no-store");

  req.log.info({ url: rawUrl, formatId, needsMerge, isConversion, ext }, "download: start");

  // ── MP3 conversion (audio extract via FFmpeg, pipe to stdout) ──────────────
  if (isConversion) {
    const abr = convAbrStr ? parseInt(convAbrStr, 10) : 192;
    const args = [
      "--ffmpeg-location", FFMPEG_PATH,
      "-f", "bestaudio/best",
      "--extract-audio",
      "--audio-format", "mp3",
      "--audio-quality", `${abr}K`,
      "--no-warnings", "--no-check-certificate",
      "--concurrent-fragments", "4",
      "-o", "-",   // pipe to stdout
      rawUrl,
    ];
    const cmd = [YT_DLP_PATH, ...args].join(" ");
    req.log.info({ cmd }, "download: MP3 conversion command");

    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Content-Disposition", `attachment; filename="${safeTitle}_${abr}kbps.mp3"`);

    // No timeout — conversion time depends on video length
    const proc = spawn(YT_DLP_PATH, args);
    proc.stdout.pipe(res);
    proc.stderr.on("data", (c: Buffer) => req.log.debug({ msg: c.toString().slice(-300) }, "yt-dlp stderr"));
    proc.on("close", (code) => req.log.info({ code, totalMs: Date.now() - t0 }, "download: MP3 done"));
    proc.on("error", (err) => {
      req.log.error({ err }, "download: MP3 process error");
      if (!res.headersSent) res.status(500).json({ error: "Conversion failed" });
    });
    return;
  }

  if (!formatId) { res.status(400).json({ error: "formatId is required" }); return; }

  // ── Merge path: download two streams → FFmpeg mux → temp file → stream ────
  //
  // IMPORTANT: we do NOT use runYtDlp (which has a 45 s timeout) here.
  // Merging can take many minutes for HD/4K content; killing it mid-write
  // produces a truncated, unplayable MP4. We use runYtDlpFile instead, which
  // has no timeout and logs the exact command for debugging.
  if (needsMerge) {
    const tmpDir = path.join(os.tmpdir(), `mediahub-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tmpDir, { recursive: true });

    // Give yt-dlp a stem; it will append the right extension (.mp4) itself
    // because we pass --merge-output-format mp4.
    const tmpStem = path.join(tmpDir, "output");
    // The actual output file will be <tmpStem>.mp4
    const tmpFile = `${tmpStem}.mp4`;

    const formatSpec = `${formatId}+bestaudio/best`;
    const args = [
      "--ffmpeg-location", FFMPEG_PATH,
      "-f", formatSpec,
      "--merge-output-format", "mp4",
      // Do NOT pass --no-part: yt-dlp needs .part files for each stream internally
      // Do NOT pass --postprocessor-args: default is already -c copy, adding it
      //   explicitly can conflict with the muxer flags yt-dlp sets internally.
      "--no-warnings",
      "--no-check-certificate",
      "--concurrent-fragments", "4",
      "-o", tmpStem,   // yt-dlp appends .mp4 → produces tmpStem.mp4
      rawUrl,
    ];

    req.log.info({
      formatId,
      formatSpec,
      tmpFile,
      cmd: [YT_DLP_PATH, ...args].join(" "),
    }, "download: merge start");

    const tMerge = Date.now();

    try {
      await runYtDlpFile(args, "merge");
      req.log.info({ mergeMs: Date.now() - tMerge, tmpFile }, "download: merge done");

      // ── Verify the file exists and is a valid MP4 before sending ──────────
      let fileSize: number;
      try {
        fileSize = statSync(tmpFile).size;
      } catch {
        req.log.error({ tmpFile }, "download: merged file not found at expected path");
        await deleteDirSilently(tmpDir);
        res.status(500).json({ error: "Merge produced no output file. Try a lower quality." });
        return;
      }

      req.log.info({ tmpFile, fileSize }, "download: verifying with ffprobe");
      const { ok, report } = await verifyMp4(tmpFile);
      req.log.info({ ok, report }, "download: ffprobe result");

      if (!ok) {
        req.log.error({ report, tmpFile }, "download: ffprobe reports invalid container — aborting");
        await deleteDirSilently(tmpDir);
        res.status(500).json({ error: "Merged file is invalid. Try a different quality." });
        return;
      }

      // ── Stream the verified file to the client ──────────────────────────
      res.setHeader("Content-Type", "video/mp4");
      res.setHeader("Content-Length", fileSize);
      res.setHeader("Content-Disposition", `attachment; filename="${safeTitle}.mp4"`);

      const stream = createReadStream(tmpFile, { highWaterMark: 512 * 1024 });
      stream.on("error", (err) => {
        req.log.error({ err }, "download: read stream error");
        // headers already sent at this point; we can only destroy the response
        res.destroy();
      });
      stream.pipe(res);

      // Delete temp files ONLY after the response is fully flushed
      res.on("finish", () => {
        req.log.info({ totalMs: Date.now() - t0 }, "download: response finished, cleaning up");
        deleteDirSilently(tmpDir);
      });
      res.on("close", () => {
        // Client disconnected early — still clean up
        deleteDirSilently(tmpDir);
      });

    } catch (err) {
      req.log.error({ err, tmpFile, totalMs: Date.now() - t0 }, "download: merge failed");
      await deleteDirSilently(tmpDir);
      if (!res.headersSent) {
        res.status(500).json({ error: "Merge failed. Try a lower quality or a different codec." });
      }
    }
    return;
  }

  // ── Direct stream path: muxed or audio-only format, no FFmpeg needed ───────
  const knownSize = fileSizeStr ? parseInt(fileSizeStr, 10) : NaN;
  if (!isNaN(knownSize) && knownSize > 0) res.setHeader("Content-Length", knownSize);

  const isAudioExt = ["m4a", "ogg", "aac", "opus"].includes(ext);
  const isWebm = ext === "webm";
  const contentType = isAudioExt ? "audio/mp4" : isWebm ? "video/webm" : "video/mp4";

  res.setHeader("Content-Type", contentType);
  res.setHeader("Content-Disposition", `attachment; filename="${safeTitle}.${ext}"`);

  const args = [
    "--ffmpeg-location", FFMPEG_PATH,
    "-f", formatId,
    // No --no-part for direct streaming: leave temp file semantics to yt-dlp
    "--no-warnings",
    "--no-check-certificate",
    "--concurrent-fragments", "4",
    "-o", "-",   // pipe directly to stdout → Express response
    rawUrl,
  ];

  const cmd = [YT_DLP_PATH, ...args].join(" ");
  req.log.info({ cmd, formatId, ext }, "download: direct stream command");

  // No timeout — large files take time
  const proc = spawn(YT_DLP_PATH, args);
  proc.stdout.pipe(res);
  proc.stderr.on("data", (c: Buffer) => req.log.debug({ msg: c.toString().slice(-300) }, "yt-dlp stderr"));
  proc.on("close", (code) => {
    req.log.info({ code, totalMs: Date.now() - t0 }, "download: direct stream done");
  });
  proc.on("error", (err) => {
    req.log.error({ err }, "download: process error");
    if (!res.headersSent) res.status(500).json({ error: "Download failed" });
  });
});

export default router;
