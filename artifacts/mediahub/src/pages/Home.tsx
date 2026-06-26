import { useState } from "react";
import { useFetchMediaInfo } from "@workspace/api-client-react";
import {
  Search, Loader2, Play, AudioLines, Download, X, Copy, Check,
  Clock, Calendar, User, Film, Merge, Music
} from "lucide-react";
import { formatBytes, formatDuration, formatDate } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";

export default function Home() {
  const [url, setUrl] = useState("");
  const [copied, setCopied] = useState(false);
  const { toast } = useToast();

  const fetchMedia = useFetchMediaInfo();

  const handleAnalyze = (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!url.trim()) return;
    fetchMedia.mutate({ data: { url: url.trim() } });
  };

  const handleCopy = () => {
    navigator.clipboard.writeText(url);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
    toast({ description: "URL copied to clipboard" });
  };

  const clearInput = () => {
    setUrl("");
    fetchMedia.reset();
  };

  const buildDownloadUrl = (params: Record<string, string | boolean | number | null | undefined>) => {
    const base = `/api/media/download?url=${encodeURIComponent(url)}`;
    const extras = Object.entries(params)
      .filter(([, v]) => v !== null && v !== undefined && v !== false && v !== "")
      .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
      .join("&");
    return extras ? `${base}&${extras}` : base;
  };

  const triggerDownload = (href: string) => {
    const a = document.createElement("a");
    a.href = href;
    a.download = "";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    toast({ title: "Download Started", description: "Your file will be ready shortly." });
  };

  const handleVideoDownload = (fmt: NonNullable<typeof result>["videoFormats"][number]) => {
    triggerDownload(
      buildDownloadUrl({
        formatId: fmt.formatId,
        needsMerge: fmt.needsMerge,
        ext: fmt.ext,
        title: result?.title,
      })
    );
  };

  const handleAudioDownload = (fmt: NonNullable<typeof result>["audioFormats"][number]) => {
    triggerDownload(
      buildDownloadUrl({
        formatId: fmt.formatId,
        isConversion: fmt.isConversion,
        conversionAbr: fmt.conversionAbr ?? undefined,
        ext: fmt.ext,
        title: result?.title,
      })
    );
  };

  const result = fetchMedia.data;
  const isPending = fetchMedia.isPending;
  const isError = fetchMedia.isError;
  const error = fetchMedia.error;

  return (
    <main className="min-h-screen relative flex flex-col items-center py-16 px-4 sm:px-6 z-10 selection:bg-white/20 selection:text-white">
      <div className="aurora-bg" />
      <div className="grain-overlay" />

      <div className="w-full max-w-5xl space-y-10">
        {/* Header */}
        <div className="text-center space-y-4">
          <div className="inline-flex items-center justify-center p-2 bg-white/5 rounded-2xl mb-4 border border-white/10 shadow-2xl">
            <div className="bg-black/50 p-3 rounded-xl border border-white/5">
              <Download className="w-6 h-6 text-white/90" />
            </div>
          </div>
          <h1 className="text-4xl sm:text-5xl md:text-6xl font-medium tracking-tight text-white drop-shadow-sm">
            MediaHub
          </h1>
          <p className="text-white/50 text-lg sm:text-xl max-w-xl mx-auto font-light">
            High-fidelity media extraction. Paste a YouTube or Instagram link.
          </p>
        </div>

        {/* Search */}
        <div className="w-full max-w-3xl mx-auto flex flex-col sm:flex-row gap-4 items-center">
          <form onSubmit={handleAnalyze} className="relative group w-full flex-1">
            <div className="absolute inset-0 bg-gradient-to-r from-blue-500/10 via-purple-500/10 to-blue-500/10 blur-xl opacity-0 group-hover:opacity-100 transition-opacity duration-500 rounded-full" />
            <div className="relative flex items-center glass-input rounded-full p-2 pl-6">
              <Search className="w-5 h-5 text-white/40 group-focus-within:text-white/80 transition-colors shrink-0" />
              <input
                type="text"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://youtube.com/watch?v=..."
                className="flex-1 bg-transparent border-none text-white placeholder:text-white/30 h-12 focus:ring-0 outline-none px-4 font-light text-base"
              />
              {url && (
                <button
                  type="button"
                  onClick={clearInput}
                  className="p-2 text-white/40 hover:text-white/80 transition-colors mr-1"
                  aria-label="Clear input"
                >
                  <X className="w-4 h-4" />
                </button>
              )}
              <Button
                type="submit"
                disabled={isPending || !url.trim()}
                className="rounded-full h-12 px-8 bg-white text-black hover:bg-white/90 font-medium tracking-wide transition-all shadow-[0_0_20px_rgba(255,255,255,0.1)] hover:shadow-[0_0_30px_rgba(255,255,255,0.2)] disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {isPending ? (
                  <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Analyzing</>
                ) : (
                  "Analyze"
                )}
              </Button>
            </div>
          </form>
          {url && (
            <Button
              type="button"
              variant="outline"
              onClick={handleCopy}
              className="rounded-full h-14 w-14 p-0 shrink-0 bg-white/5 border-white/10 hover:bg-white/10 hover:border-white/20 text-white backdrop-blur-md transition-all shadow-xl"
              title="Copy URL"
            >
              {copied ? <Check className="w-5 h-5 text-green-400" /> : <Copy className="w-5 h-5" />}
            </Button>
          )}
        </div>

        {/* Error */}
        {isError && (
          <Alert variant="destructive" className="glass-panel border-red-500/20 bg-red-500/10 max-w-2xl mx-auto">
            <AlertTitle>Extraction Failed</AlertTitle>
            <AlertDescription className="text-red-200/80">
              {error?.error ?? "Couldn't analyze that URL. Make sure it's a valid YouTube or Instagram link."}
            </AlertDescription>
            <Button
              variant="outline"
              size="sm"
              onClick={() => handleAnalyze()}
              className="mt-4 border-red-500/30 hover:bg-red-500/20 text-red-100"
            >
              Try Again
            </Button>
          </Alert>
        )}

        {/* Results */}
        {result && !isPending && (
          <div className="glass-panel rounded-3xl overflow-hidden animate-in fade-in slide-in-from-bottom-8 duration-700 ease-out">

            {/* Metadata row */}
            <div className="flex flex-col md:flex-row gap-0 border-b border-white/5">
              <div className="relative w-full md:w-64 shrink-0 aspect-video md:aspect-auto bg-black/40">
                <img
                  src={result.thumbnail}
                  alt={result.title}
                  className="w-full h-full object-cover"
                />
                <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/10 to-transparent" />
                <Badge className="absolute bottom-3 right-3 bg-black/70 text-white border-white/10 backdrop-blur-md font-mono text-xs">
                  {formatDuration(result.duration)}
                </Badge>
                <Badge className="absolute top-3 left-3 bg-black/70 text-white border-white/10 backdrop-blur-md uppercase tracking-wider text-[10px]">
                  {result.platform}
                </Badge>
              </div>

              <div className="flex-1 p-6 flex flex-col justify-center space-y-3">
                <h2 className="text-xl font-medium text-white leading-snug line-clamp-2" title={result.title}>
                  {result.title}
                </h2>
                <div className="flex flex-wrap gap-4 text-sm text-white/50">
                  <span className="flex items-center gap-2"><User className="w-4 h-4 text-white/30" />{result.channel}</span>
                  {result.uploadDate && (
                    <span className="flex items-center gap-2"><Calendar className="w-4 h-4 text-white/30" />{formatDate(result.uploadDate)}</span>
                  )}
                  <span className="flex items-center gap-2"><Clock className="w-4 h-4 text-white/30" />{formatDuration(result.duration)}</span>
                </div>
                <div className="flex gap-2 text-xs text-white/30 mt-1">
                  <span>{result.videoFormats.length} video format{result.videoFormats.length !== 1 ? "s" : ""}</span>
                  <span>·</span>
                  <span>{result.audioFormats.length} audio format{result.audioFormats.length !== 1 ? "s" : ""}</span>
                </div>
              </div>
            </div>

            {/* Format tabs */}
            <div className="p-6">
              <Tabs defaultValue="video" className="w-full">
                <TabsList className="w-full bg-white/5 border border-white/10 p-1 rounded-xl grid grid-cols-2 mb-6">
                  <TabsTrigger value="video" className="rounded-lg data-[state=active]:bg-white/10 data-[state=active]:text-white text-white/50 transition-all">
                    <Film className="w-4 h-4 mr-2" />
                    Video ({result.videoFormats.length})
                  </TabsTrigger>
                  <TabsTrigger value="audio" className="rounded-lg data-[state=active]:bg-white/10 data-[state=active]:text-white text-white/50 transition-all">
                    <AudioLines className="w-4 h-4 mr-2" />
                    Audio ({result.audioFormats.length})
                  </TabsTrigger>
                </TabsList>

                {/* Video formats table */}
                <TabsContent value="video" className="mt-0">
                  {result.videoFormats.length > 0 ? (
                    <div className="overflow-x-auto rounded-xl border border-white/5">
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="border-b border-white/5 bg-white/[0.02]">
                            <th className="text-left px-4 py-3 text-white/40 font-medium">Resolution</th>
                            <th className="text-left px-4 py-3 text-white/40 font-medium">Ext</th>
                            <th className="text-left px-4 py-3 text-white/40 font-medium">FPS</th>
                            <th className="text-left px-4 py-3 text-white/40 font-medium">Size</th>
                            <th className="text-left px-4 py-3 text-white/40 font-medium">Video</th>
                            <th className="text-left px-4 py-3 text-white/40 font-medium">Audio</th>
                            <th className="text-right px-4 py-3 text-white/40 font-medium"></th>
                          </tr>
                        </thead>
                        <tbody>
                          {result.videoFormats.map((fmt, idx) => (
                            <tr
                              key={`${fmt.formatId}-${idx}`}
                              className="border-b border-white/[0.03] hover:bg-white/[0.03] transition-colors group"
                            >
                              <td className="px-4 py-3">
                                <span className="font-semibold text-white">{fmt.quality}</span>
                              </td>
                              <td className="px-4 py-3">
                                <span className="text-white/50 uppercase text-xs font-mono">{fmt.ext}</span>
                              </td>
                              <td className="px-4 py-3">
                                <span className="text-white/50">{fmt.fps ? `${fmt.fps}` : "—"}</span>
                              </td>
                              <td className="px-4 py-3">
                                <span className="text-white/50">{formatBytes(fmt.filesize)}</span>
                              </td>
                              <td className="px-4 py-3">
                                <span className="text-white/50 font-mono text-xs">{fmt.vcodec ?? "—"}</span>
                              </td>
                              <td className="px-4 py-3">
                                {fmt.needsMerge ? (
                                  <span className="inline-flex items-center gap-1 text-amber-400/80 text-xs">
                                    <Merge className="w-3 h-3" />
                                    merged
                                  </span>
                                ) : (
                                  <span className="text-white/50 font-mono text-xs">{fmt.acodec ?? "—"}</span>
                                )}
                              </td>
                              <td className="px-4 py-3 text-right">
                                <Button
                                  onClick={() => handleVideoDownload(fmt)}
                                  size="sm"
                                  className="bg-white text-black hover:bg-white/90 rounded-full px-4 h-8 text-xs font-medium opacity-0 group-hover:opacity-100 transition-all duration-200 focus:opacity-100"
                                >
                                  <Download className="w-3 h-3 mr-1.5" />
                                  Download
                                </Button>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <EmptyState icon={<Film className="w-10 h-10 text-white/10" />} message="No video formats found." />
                  )}

                  <p className="mt-4 text-xs text-white/25 text-center">
                    Formats marked "merged" combine a high-quality video stream with audio via FFmpeg — may take longer to start.
                  </p>
                </TabsContent>

                {/* Audio formats table */}
                <TabsContent value="audio" className="mt-0">
                  {result.audioFormats.length > 0 ? (
                    <div className="overflow-x-auto rounded-xl border border-white/5">
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="border-b border-white/5 bg-white/[0.02]">
                            <th className="text-left px-4 py-3 text-white/40 font-medium">Format</th>
                            <th className="text-left px-4 py-3 text-white/40 font-medium">Codec</th>
                            <th className="text-left px-4 py-3 text-white/40 font-medium">Bitrate</th>
                            <th className="text-left px-4 py-3 text-white/40 font-medium">Est. Size</th>
                            <th className="text-right px-4 py-3 text-white/40 font-medium"></th>
                          </tr>
                        </thead>
                        <tbody>
                          {result.audioFormats.map((fmt, idx) => (
                            <tr
                              key={`${fmt.formatId}-${idx}`}
                              className="border-b border-white/[0.03] hover:bg-white/[0.03] transition-colors group"
                            >
                              <td className="px-4 py-3">
                                <div className="flex items-center gap-2">
                                  <span className="font-medium text-white">{fmt.label}</span>
                                  {fmt.isConversion && (
                                    <Badge variant="outline" className="text-[10px] text-amber-400/70 border-amber-400/20 py-0 px-1.5 h-4">
                                      converted
                                    </Badge>
                                  )}
                                </div>
                              </td>
                              <td className="px-4 py-3">
                                <span className="text-white/50 font-mono text-xs">{fmt.acodec ?? "—"}</span>
                              </td>
                              <td className="px-4 py-3">
                                <span className="text-white/50">{fmt.abr ? `${Math.round(fmt.abr)}kbps` : "—"}</span>
                              </td>
                              <td className="px-4 py-3">
                                <span className="text-white/50">{formatBytes(fmt.filesize)}</span>
                              </td>
                              <td className="px-4 py-3 text-right">
                                <Button
                                  onClick={() => handleAudioDownload(fmt)}
                                  size="sm"
                                  className="bg-white text-black hover:bg-white/90 rounded-full px-4 h-8 text-xs font-medium opacity-0 group-hover:opacity-100 transition-all duration-200 focus:opacity-100"
                                >
                                  <Download className="w-3 h-3 mr-1.5" />
                                  Download
                                </Button>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <EmptyState icon={<Music className="w-10 h-10 text-white/10" />} message="No audio formats found." />
                  )}
                </TabsContent>
              </Tabs>
            </div>
          </div>
        )}
      </div>
    </main>
  );
}

function EmptyState({ icon, message }: { icon: React.ReactNode; message: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center space-y-4">
      {icon}
      <p className="text-white/40">{message}</p>
    </div>
  );
}
