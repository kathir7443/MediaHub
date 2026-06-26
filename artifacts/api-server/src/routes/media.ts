import { Router, type IRouter, type Request, type Response } from "express";
import { spawn } from "child_process";
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
    const proc = spawn(YT_DLP_PATH, args, { timeout: 45000 });
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
  // Strip trailing codec detail: avc1.640028 -> avc1, vp09.00.50.08 -> vp9
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

router.post("/media/info", async (req: Request, res: Response): Promise<void> => {
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

  try {
    const jsonOut = await runYtDlp([
      "--dump-json",
      "--no-playlist",
      "--no-warnings",
      "--no-check-certificate",
      url,
    ]);

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

    req.log.info({ formatCount: rawFormats.length, url }, "Raw formats received from yt-dlp");

    // --- Video formats ---
    // Include both muxed (video+audio) and video-only streams.
    // Video-only streams (1080p, 1440p, 4K) require FFmpeg merging at download time.
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

      // Must have video and a real height
      if (!vcodec || vcodec === "none" || !height || height < 100) continue;

      // Skip storyboard/thumbnail formats
      const formatNote = (fmt["format_note"] as string | undefined) ?? "";
      if (formatNote.toLowerCase().includes("storyboard")) continue;
      if (formatNote.toLowerCase().includes("premium")) continue;

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

    // Sort: highest resolution first, then by bitrate descending within same height
    videoFormats.sort((a, b) => {
      const hDiff = (b.height ?? 0) - (a.height ?? 0);
      if (hDiff !== 0) return hDiff;
      return (b.tbr ?? 0) - (a.tbr ?? 0);
    });

    req.log.info({ videoFormatCount: videoFormats.length }, "Video formats extracted");

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

    // MP3 conversions first (if ffmpeg is available)
    const MP3_BITRATES = [320, 192, 128];
    for (const abr of MP3_BITRATES) {
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

    // Original audio-only streams from yt-dlp, sorted by bitrate descending
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

    res.json({
      title,
      thumbnail,
      duration,
      channel,
      uploadDate,
      platform,
      videoFormats,
      audioFormats,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    req.log.error({ err, url }, "Failed to fetch media info");

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

router.get("/media/download", async (req: Request, res: Response): Promise<void> => {
  const rawUrl = req.query["url"] as string | undefined;
  const formatId = req.query["formatId"] as string | undefined;
  const needsMerge = req.query["needsMerge"] === "true";
  const isConversion = req.query["isConversion"] === "true";
  const conversionAbrStr = req.query["conversionAbr"] as string | undefined;
  const ext = (req.query["ext"] as string | undefined) || "mp4";

  if (!rawUrl) {
    res.status(400).json({ error: "url query param is required" });
    return;
  }

  req.log.info({ url: rawUrl, formatId, needsMerge, isConversion, ext }, "Starting media download");

  const title = (req.query["title"] as string | undefined) || "media";
  const safeTitle = title.replace(/[^a-z0-9_\-. ]/gi, "_").slice(0, 80);

  try {
    // MP3 conversion download
    if (isConversion) {
      const abr = conversionAbrStr ? parseInt(conversionAbrStr, 10) : 192;
      const args = [
        "--ffmpeg-location", FFMPEG_PATH,
        "-f", "bestaudio",
        "--extract-audio",
        "--audio-format", "mp3",
        "--audio-quality", `${abr}K`,
        "-o", "-",
        "--no-warnings",
        "--no-check-certificate",
        rawUrl,
      ];

      res.setHeader("Content-Type", "audio/mpeg");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${safeTitle}_${abr}kbps.mp3"`
      );

      const proc = spawn(YT_DLP_PATH, args);
      proc.stdout.pipe(res);
      proc.stderr.on("data", (chunk: Buffer) => {
        req.log.debug({ msg: chunk.toString().slice(-500) }, "yt-dlp stderr");
      });
      proc.on("close", (code) => {
        if (code !== 0) req.log.warn({ code }, "yt-dlp MP3 conversion exited non-zero");
      });
      proc.on("error", (err) => {
        req.log.error({ err }, "yt-dlp process error");
        if (!res.headersSent) res.status(500).json({ error: "Download failed" });
      });
      return;
    }

    if (!formatId) {
      res.status(400).json({ error: "formatId is required" });
      return;
    }

    // Video-only streams: merge with best available audio using FFmpeg
    // Muxed streams: download directly
    const formatSpec = needsMerge
      ? `${formatId}+bestaudio/best`
      : formatId;

    const isAudio = ["m4a", "opus", "webm", "ogg", "aac"].includes(ext);
    const contentType = isAudio ? "audio/mp4" : "video/mp4";
    const fileExt = needsMerge ? "mp4" : ext;

    const args: string[] = [
      "--ffmpeg-location", FFMPEG_PATH,
      "-f", formatSpec,
    ];

    // Merge output into mp4 container when combining streams
    if (needsMerge) {
      args.push("--merge-output-format", "mp4");
    }

    args.push(
      "-o", "-",
      "--no-warnings",
      "--no-check-certificate",
      rawUrl,
    );

    res.setHeader("Content-Type", contentType);
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${safeTitle}.${fileExt}"`
    );

    const proc = spawn(YT_DLP_PATH, args);
    proc.stdout.pipe(res);
    proc.stderr.on("data", (chunk: Buffer) => {
      req.log.debug({ msg: chunk.toString().slice(-500) }, "yt-dlp stderr");
    });
    proc.on("close", (code) => {
      if (code !== 0) req.log.warn({ code, formatSpec }, "yt-dlp download exited non-zero");
    });
    proc.on("error", (err) => {
      req.log.error({ err }, "yt-dlp process error");
      if (!res.headersSent) res.status(500).json({ error: "Download failed" });
    });
  } catch (err) {
    req.log.error({ err }, "Download route error");
    if (!res.headersSent) res.status(500).json({ error: "Download failed" });
  }
});

export default router;
