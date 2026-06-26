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
    const y = raw.slice(0, 4);
    const m = raw.slice(4, 6);
    const d = raw.slice(6, 8);
    return `${y}-${m}-${d}`;
  }
  return raw;
}

function estimateAudioSize(durationSec: number, bitrateKbps: number): number {
  return Math.round((bitrateKbps * 1000 * durationSec) / 8);
}

function runYtDlp(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(YT_DLP_PATH, args, { timeout: 30000 });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    proc.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    proc.on("close", (code) => {
      if (code === 0) {
        resolve(stdout.trim());
      } else {
        reject(new Error(stderr || `yt-dlp exited with code ${code}`));
      }
    });
    proc.on("error", reject);
  });
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
      url,
    ]);

    let info: Record<string, unknown>;
    try {
      info = JSON.parse(jsonOut);
    } catch {
      res.status(422).json({ error: "Could not parse media info. The URL may be invalid or private." });
      return;
    }

    const title = (info["title"] as string) || "Unknown Title";
    const thumbnail = (info["thumbnail"] as string) || "";
    const duration = (info["duration"] as number) || 0;
    const channel = (info["uploader"] as string) || (info["channel"] as string) || "Unknown";
    const uploadDate = formatUploadDate(info["upload_date"] as string | undefined);
    const rawFormats = (info["formats"] as Record<string, unknown>[]) || [];

    const videoFormats: {
      formatId: string;
      quality: string;
      ext: string;
      filesize: number | null;
      fps: number | null;
      url: string;
      vcodec: string | null;
    }[] = [];

    const seenQualities = new Set<string>();

    for (const fmt of rawFormats) {
      const vcodec = fmt["vcodec"] as string | undefined;
      const acodec = fmt["acodec"] as string | undefined;
      const height = fmt["height"] as number | undefined;
      const fmtUrl = fmt["url"] as string | undefined;
      const ext = (fmt["ext"] as string) || "mp4";
      const formatId = fmt["format_id"] as string;

      if (!vcodec || vcodec === "none" || !height || !fmtUrl) continue;
      if (!acodec || acodec === "none") continue;

      const quality = `${height}p`;
      if (seenQualities.has(quality)) continue;
      seenQualities.add(quality);

      videoFormats.push({
        formatId,
        quality,
        ext: ext === "webm" ? "webm" : "mp4",
        filesize: (fmt["filesize"] as number | null) || (fmt["filesize_approx"] as number | null) || null,
        fps: (fmt["fps"] as number | null) || null,
        url: `/api/media/download?url=${encodeURIComponent(url)}&formatId=${encodeURIComponent(formatId)}`,
        vcodec: vcodec || null,
      });
    }

    videoFormats.sort((a, b) => {
      const aH = parseInt(a.quality, 10);
      const bH = parseInt(b.quality, 10);
      return bH - aH;
    });

    const AUDIO_BITRATES = [320, 256, 192, 128];
    const audioFormats: {
      formatId: string;
      label: string;
      ext: string;
      filesize: number | null;
      url: string;
      abr: number | null;
    }[] = [];

    for (const abr of AUDIO_BITRATES) {
      audioFormats.push({
        formatId: `mp3-${abr}`,
        label: `MP3 ${abr}kbps`,
        ext: "mp3",
        filesize: duration > 0 ? estimateAudioSize(duration, abr) : null,
        url: `/api/media/download?url=${encodeURIComponent(url)}&audioOnly=true&abr=${abr}`,
        abr,
      });
    }

    const originalAudio = rawFormats
      .filter((f) => {
        const vc = f["vcodec"] as string | undefined;
        const ac = f["acodec"] as string | undefined;
        return (!vc || vc === "none") && ac && ac !== "none";
      })
      .sort((a, b) => ((b["abr"] as number) || 0) - ((a["abr"] as number) || 0))[0];

    if (originalAudio) {
      audioFormats.push({
        formatId: originalAudio["format_id"] as string,
        label: `Original (${originalAudio["ext"] || "audio"})`,
        ext: (originalAudio["ext"] as string) || "m4a",
        filesize:
          (originalAudio["filesize"] as number | null) ||
          (originalAudio["filesize_approx"] as number | null) ||
          null,
        url: `/api/media/download?url=${encodeURIComponent(url)}&formatId=${encodeURIComponent(originalAudio["format_id"] as string)}`,
        abr: (originalAudio["abr"] as number | null) || null,
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

    if (message.includes("Private") || message.includes("private")) {
      res.status(422).json({ error: "This content is private and cannot be accessed." });
      return;
    }
    if (message.includes("not a bot") || message.includes("Sign in")) {
      res.status(422).json({ error: "YouTube requires authentication for this content." });
      return;
    }
    res.status(422).json({ error: "Failed to fetch media info. Please check the URL and try again." });
  }
});

router.get("/media/download", async (req: Request, res: Response): Promise<void> => {
  const rawUrl = req.query["url"] as string | undefined;
  const formatId = req.query["formatId"] as string | undefined;
  const audioOnly = req.query["audioOnly"] === "true";
  const abrStr = req.query["abr"] as string | undefined;

  if (!rawUrl) {
    res.status(400).json({ error: "url query param is required" });
    return;
  }

  const abr = abrStr ? parseInt(abrStr, 10) : 192;

  req.log.info({ url: rawUrl, formatId, audioOnly, abr }, "Starting media download");

  try {
    if (audioOnly) {
      const args = [
        "--ffmpeg-location", FFMPEG_PATH,
        "-f", "bestaudio",
        "--extract-audio",
        "--audio-format", "mp3",
        "--audio-quality", `${abr}K`,
        "-o", "-",
        "--no-warnings",
        rawUrl,
      ];

      res.setHeader("Content-Type", "audio/mpeg");
      res.setHeader("Content-Disposition", `attachment; filename="audio_${abr}kbps.mp3"`);

      const proc = spawn(YT_DLP_PATH, args);
      proc.stdout.pipe(res);
      proc.stderr.on("data", (chunk: Buffer) => {
        req.log.debug({ msg: chunk.toString() }, "yt-dlp stderr");
      });
      proc.on("error", (err) => {
        req.log.error({ err }, "yt-dlp process error");
        if (!res.headersSent) {
          res.status(500).json({ error: "Download failed" });
        }
      });
      return;
    }

    if (!formatId) {
      res.status(400).json({ error: "formatId is required for video downloads" });
      return;
    }

    const args = [
      "--ffmpeg-location", FFMPEG_PATH,
      "-f", formatId,
      "-o", "-",
      "--no-warnings",
      rawUrl,
    ];

    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Content-Disposition", `attachment; filename="video_${formatId}.mp4"`);

    const proc = spawn(YT_DLP_PATH, args);
    proc.stdout.pipe(res);
    proc.stderr.on("data", (chunk: Buffer) => {
      req.log.debug({ msg: chunk.toString() }, "yt-dlp stderr");
    });
    proc.on("error", (err) => {
      req.log.error({ err }, "yt-dlp process error");
      if (!res.headersSent) {
        res.status(500).json({ error: "Download failed" });
      }
    });
  } catch (err) {
    req.log.error({ err }, "Download route error");
    if (!res.headersSent) {
      res.status(500).json({ error: "Download failed" });
    }
  }
});

export default router;
