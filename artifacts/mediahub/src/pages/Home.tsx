import { useState, useRef } from "react";
import { useFetchMediaInfo } from "@workspace/api-client-react";
import { Search, Loader2, Play, AudioLines, Download, X, Copy, Check, Clock, Calendar, User, Film } from "lucide-react";
import { formatBytes, formatDuration, formatDate, cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
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
    
    fetchMedia.mutate({ data: { url: url.trim() } }, {
      onError: () => {
        toast({
          title: "Error",
          description: "Failed to fetch media info. Please check the URL and try again.",
          variant: "destructive"
        });
      }
    });
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

  const handleDownload = (formatId: string) => {
    const downloadUrl = `/api/media/download?url=${encodeURIComponent(url)}&formatId=${encodeURIComponent(formatId)}`;
    
    // Create a temporary anchor element to trigger the download
    const a = document.createElement("a");
    a.href = downloadUrl;
    a.download = "";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    
    toast({
      title: "Download Started",
      description: "Your file is being downloaded.",
    });
  };

  const result = fetchMedia.data;
  const isPending = fetchMedia.isPending;
  const isError = fetchMedia.isError;
  const error = fetchMedia.error;

  return (
    <main className="min-h-screen relative flex flex-col items-center py-20 px-4 sm:px-6 z-10 selection:bg-white/20 selection:text-white">
      {/* Background elements */}
      <div className="aurora-bg"></div>
      <div className="grain-overlay"></div>
      
      <div className="w-full max-w-4xl space-y-12">
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
            High-fidelity media extraction. Paste a link from YouTube or Instagram to analyze and download.
          </p>
        </div>

        {/* Search Input */}
        <div className="w-full max-w-3xl mx-auto flex flex-col sm:flex-row gap-4 items-center">
          <form onSubmit={handleAnalyze} className="relative group w-full flex-1">
            <div className="absolute inset-0 bg-gradient-to-r from-blue-500/10 via-purple-500/10 to-blue-500/10 blur-xl opacity-0 group-hover:opacity-100 transition-opacity duration-500 rounded-full" />
            <div className="relative flex items-center glass-input rounded-full p-2 pl-6">
              <Search className="w-5 h-5 text-white/40 group-focus-within:text-white/80 transition-colors" />
              <input
                type="text"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://youtube.com/watch?v=..."
                className="flex-1 bg-transparent border-none text-white placeholder:text-white/30 h-12 focus:ring-0 outline-none px-4 font-light text-lg"
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
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    Analyzing
                  </>
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

        {/* Error State */}
        {isError && (
          <Alert variant="destructive" className="glass-panel border-red-500/20 bg-red-500/10 max-w-2xl mx-auto">
            <AlertTitle>Extraction Failed</AlertTitle>
            <AlertDescription className="text-red-200/80">
              {error?.error || "We couldn't analyze that URL. Make sure it's a valid YouTube or Instagram link and try again."}
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

        {/* Results Card */}
        {result && !isPending && (
          <div className="glass-panel rounded-3xl overflow-hidden animate-in fade-in slide-in-from-bottom-8 duration-700 ease-out flex flex-col md:flex-row">
            
            {/* Left: Metadata */}
            <div className="w-full md:w-1/3 bg-black/40 border-r border-white/5 p-6 sm:p-8 flex flex-col space-y-6">
              <div className="relative aspect-video rounded-xl overflow-hidden bg-white/5 border border-white/10 shadow-inner group">
                <img 
                  src={result.thumbnail} 
                  alt={result.title} 
                  className="w-full h-full object-cover transition-transform duration-700 group-hover:scale-105"
                />
                <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/20 to-transparent" />
                <Badge variant="secondary" className="absolute bottom-3 right-3 bg-black/60 text-white border-white/10 backdrop-blur-md font-mono text-xs">
                  {formatDuration(result.duration)}
                </Badge>
                <Badge variant="secondary" className="absolute top-3 right-3 bg-black/60 text-white border-white/10 backdrop-blur-md uppercase tracking-wider text-[10px]">
                  {result.platform}
                </Badge>
              </div>

              <div className="space-y-4">
                <h2 className="text-xl font-medium text-white leading-snug line-clamp-3" title={result.title}>
                  {result.title}
                </h2>
                
                <div className="space-y-3 text-sm text-white/60">
                  <div className="flex items-center gap-3">
                    <User className="w-4 h-4 text-white/40" />
                    <span className="truncate">{result.channel}</span>
                  </div>
                  {result.uploadDate && (
                    <div className="flex items-center gap-3">
                      <Calendar className="w-4 h-4 text-white/40" />
                      <span>{formatDate(result.uploadDate)}</span>
                    </div>
                  )}
                  <div className="flex items-center gap-3">
                    <Clock className="w-4 h-4 text-white/40" />
                    <span>{formatDuration(result.duration)}</span>
                  </div>
                </div>
              </div>
            </div>

            {/* Right: Formats */}
            <div className="w-full md:w-2/3 p-6 sm:p-8 bg-black/20">
              <Tabs defaultValue="video" className="w-full h-full flex flex-col">
                <TabsList className="w-full bg-white/5 border border-white/10 p-1 rounded-xl grid grid-cols-2 mb-6">
                  <TabsTrigger value="video" className="rounded-lg data-[state=active]:bg-white/10 data-[state=active]:text-white text-white/50 transition-all">
                    <Film className="w-4 h-4 mr-2" />
                    Video
                  </TabsTrigger>
                  <TabsTrigger value="audio" className="rounded-lg data-[state=active]:bg-white/10 data-[state=active]:text-white text-white/50 transition-all">
                    <AudioLines className="w-4 h-4 mr-2" />
                    Audio Only
                  </TabsTrigger>
                </TabsList>

                <ScrollArea className="flex-1 -mx-2 px-2 h-[400px]">
                  <TabsContent value="video" className="mt-0 space-y-2">
                    {result.videoFormats.length > 0 ? (
                      result.videoFormats.map((format, idx) => (
                        <div key={`${format.formatId}-${idx}`} className="group flex items-center justify-between p-4 rounded-xl border border-white/5 bg-white/[0.02] hover:bg-white/[0.04] hover:border-white/10 transition-all duration-300">
                          <div className="flex items-center gap-4">
                            <div className="flex flex-col">
                              <div className="flex items-center gap-2">
                                <span className="font-medium text-white">{format.quality}</span>
                                <Badge variant="outline" className="text-[10px] text-white/40 border-white/10 uppercase py-0 px-1.5 h-5">
                                  {format.ext}
                                </Badge>
                              </div>
                              <div className="flex items-center gap-2 text-xs text-white/40 mt-1">
                                <span>{formatBytes(format.filesize)}</span>
                                {format.fps && (
                                  <>
                                    <span>•</span>
                                    <span>{format.fps}fps</span>
                                  </>
                                )}
                                {format.vcodec && (
                                  <>
                                    <span>•</span>
                                    <span className="truncate max-w-[100px]" title={format.vcodec}>{format.vcodec}</span>
                                  </>
                                )}
                              </div>
                            </div>
                          </div>
                          <Button 
                            onClick={() => handleDownload(format.formatId)}
                            variant="secondary"
                            size="sm"
                            className="bg-white text-black hover:bg-white/90 rounded-full px-5 shadow-[0_2px_10px_rgba(255,255,255,0.1)] opacity-0 group-hover:opacity-100 transition-all duration-300 translate-y-1 group-hover:translate-y-0 focus:opacity-100 focus:translate-y-0"
                          >
                            <Download className="w-4 h-4 mr-2" />
                            Get
                          </Button>
                        </div>
                      ))
                    ) : (
                      <div className="flex flex-col items-center justify-center py-12 text-center">
                        <Film className="w-12 h-12 text-white/10 mb-4" />
                        <p className="text-white/50">No video formats found.</p>
                      </div>
                    )}
                  </TabsContent>

                  <TabsContent value="audio" className="mt-0 space-y-2">
                    {result.audioFormats.length > 0 ? (
                      result.audioFormats.map((format, idx) => (
                        <div key={`${format.formatId}-${idx}`} className="group flex items-center justify-between p-4 rounded-xl border border-white/5 bg-white/[0.02] hover:bg-white/[0.04] hover:border-white/10 transition-all duration-300">
                          <div className="flex items-center gap-4">
                            <div className="flex flex-col">
                              <div className="flex items-center gap-2">
                                <span className="font-medium text-white">{format.label}</span>
                                <Badge variant="outline" className="text-[10px] text-white/40 border-white/10 uppercase py-0 px-1.5 h-5">
                                  {format.ext}
                                </Badge>
                              </div>
                              <div className="flex items-center gap-2 text-xs text-white/40 mt-1">
                                <span>{formatBytes(format.filesize)}</span>
                                {format.abr && (
                                  <>
                                    <span>•</span>
                                    <span>{format.abr} kbps</span>
                                  </>
                                )}
                              </div>
                            </div>
                          </div>
                          <Button 
                            onClick={() => handleDownload(format.formatId)}
                            variant="secondary"
                            size="sm"
                            className="bg-white text-black hover:bg-white/90 rounded-full px-5 shadow-[0_2px_10px_rgba(255,255,255,0.1)] opacity-0 group-hover:opacity-100 transition-all duration-300 translate-y-1 group-hover:translate-y-0 focus:opacity-100 focus:translate-y-0"
                          >
                            <Download className="w-4 h-4 mr-2" />
                            Get
                          </Button>
                        </div>
                      ))
                    ) : (
                      <div className="flex flex-col items-center justify-center py-12 text-center">
                        <AudioLines className="w-12 h-12 text-white/10 mb-4" />
                        <p className="text-white/50">No audio formats found.</p>
                      </div>
                    )}
                  </TabsContent>
                </ScrollArea>
              </Tabs>
            </div>
            
          </div>
        )}
      </div>
    </main>
  );
}
