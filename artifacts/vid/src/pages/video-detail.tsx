import { useState, useEffect, useRef, Fragment } from "react"
import { useParams, Link } from "wouter"
import { useGetVideo, useUpdateVideo, getGetVideoQueryKey, useGetAuthenticatedVideoPlayback, getGetAuthenticatedVideoPlaybackQueryKey, useGetWorkspace } from "@workspace/api-client-react"
import { useQueryClient } from "@tanstack/react-query"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { Skeleton } from "@/components/ui/skeleton"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { ArrowLeft, Copy, ExternalLink, Activity, Check, XCircle, Folder as FolderIcon, ChevronRight } from "lucide-react"
import { formatDate, formatDuration, formatNumber } from "@/lib/utils"
import { Player } from "@/components/player"
import { MoveVideoDialog } from "@/components/video-library/move-video-dialog"

export default function VideoDetail() {
  const { id } = useParams<{ id: string }>()
  const { data: video, isLoading } = useGetVideo(id)
  const { data: playbackData } = useGetAuthenticatedVideoPlayback(id, {
    query: {
      queryKey: getGetAuthenticatedVideoPlaybackQueryKey(id),
      retry: (failureCount, error: any) => {
        if (error?.status === 404 || error?.status === 503) return false;
        return failureCount < 3;
      }
    }
  })

  const queryClient = useQueryClient()
  const updateVideo = useUpdateVideo()
  const { data: workspace } = useGetWorkspace()
  const canUpdate = workspace?.permissions?.includes("videos.update") ?? false

  const [title, setTitle] = useState("")
  const [description, setDescription] = useState("")
  const initializedId = useRef<string | null>(null)

  const [copyStatus, setCopyStatus] = useState<"idle" | "success" | "error">("idle")
  const [moveVideoOpen, setMoveVideoOpen] = useState(false)

  useEffect(() => {
    if (video && initializedId.current !== id) {
      setTitle(video.title)
      setDescription(video.description)
      initializedId.current = id
    }
  }, [video, id])

  const handleUpdate = (updates: any) => {
    updateVideo.mutate({ videoId: id, data: updates }, {
      onSuccess: (updatedData) => {
        queryClient.setQueryData(getGetVideoQueryKey(id), (old: any) =>
          old ? { ...old, ...updatedData } : old
        )
      }
    })
  }

  const handleVisibilityChange = (value: string) => {
    handleUpdate({ visibility: value })
  }

  const handleCopy = async () => {
    if (!video?.embedCode) return;
    try {
      await navigator.clipboard.writeText(video.embedCode);
      setCopyStatus("success");
    } catch (err) {
      setCopyStatus("error");
    } finally {
      setTimeout(() => setCopyStatus("idle"), 2000);
    }
  }

  if (isLoading && !video) {
    return <div className="p-8 space-y-8"><Skeleton className="h-12 w-64" /><Skeleton className="h-96 w-full" /></div>
  }

  if (!video) {
    return <div className="p-8 text-center">Video not found.</div>
  }

  const embedUrl = video.embedUrl || ""
  const embedCode = video.embedCode || ""
  const embedReady = !!video.embedCode && video.status === 'ready'

  const src = playbackData?.sourceUrl
    ? {
        src: playbackData.sourceUrl,
        type: playbackData.sourceType === 'hls' ? 'application/x-mpegurl' : 'video/mp4'
      }
    : null;

  const isPlayable = video.status === 'ready' && !!src;

  return (
    <div className="flex-1 flex flex-col min-h-0 bg-secondary/30">
      {/* Header */}
      <div className="border-b bg-background px-8 py-4 flex items-center justify-between sticky top-0 z-10">
        <div className="flex items-center gap-4">
          <Link href="/videos" className="text-muted-foreground hover:text-foreground transition-colors p-2 -ml-2 rounded-md hover:bg-muted">
            <ArrowLeft className="h-5 w-5" />
          </Link>
          <div>
            <div className="flex items-center gap-3">
              <h1 className="text-xl font-bold tracking-tight">{video.title}</h1>
              <Badge variant={video.status === 'ready' ? 'success' : 'warning'}>{video.status}</Badge>
            </div>

            <div className="flex items-center flex-wrap gap-1 mt-1.5 text-xs text-muted-foreground font-medium">
              <FolderIcon className="h-3.5 w-3.5 mr-0.5" />
              {video.folderPath && video.folderPath.length > 0 ? (
                video.folderPath.map((anc, idx) => (
                  <Fragment key={anc.id}>
                    {idx > 0 && <ChevronRight className="h-3 w-3 opacity-50" />}
                    <Link href={`/videos?folder=${anc.id}`} className="hover:text-foreground transition-colors">{anc.name}</Link>
                  </Fragment>
                ))
              ) : (
                <Link href="/videos" className="hover:text-foreground transition-colors">Library</Link>
              )}

              {canUpdate && (
                <Button variant="ghost" size="sm" className="h-5 px-1.5 ml-2 text-[10px] uppercase tracking-wider bg-muted/50 hover:bg-muted" onClick={() => setMoveVideoOpen(true)}>
                  Change
                </Button>
              )}
            </div>

            <p className="text-xs text-muted-foreground/60 font-mono mt-1">ID: {video.id} • Added {formatDate(video.createdAt)}</p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <Button variant="outline" className="gap-2" asChild disabled={!embedUrl}>
            <a href={embedUrl || '#'} target="_blank" rel="noreferrer">
              <ExternalLink className="h-4 w-4" /> Preview
            </a>
          </Button>
          {canUpdate && (
            <Button className="gap-2" onClick={() => handleUpdate({ title, description })}>
              Save Changes
            </Button>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-8">
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8 max-w-6xl mx-auto">

          <div className="lg:col-span-2 space-y-8">
            {/* Player Preview */}
            <div className="w-full shadow-lg ring-1 ring-border rounded-lg overflow-hidden bg-black relative">
               <Player
                 title={video.title}
                 src={isPlayable ? src : null}
                 poster={playbackData?.posterUrl || null}
                 accentColor={playbackData?.playerAccent || video.thumbnailColor}
                 controlForegroundColor={playbackData?.playerControlForeground || '#ffffff'}
                 controlBackgroundColor={playbackData?.playerControlBackground || '#000000'}
                 posterTreatment={playbackData?.posterTreatment || 'default'}
                 status={!isPlayable ? video.status : undefined}
                 message={video.status === 'ready' && !src ? "Playback source is not connected." : undefined}
                 className="rounded-lg"
               />
               {isPlayable && (
                 <div className="absolute top-4 right-4 bg-black/60 backdrop-blur-md text-white text-xs font-mono px-2 py-1 rounded pointer-events-none z-10">
                   {formatDuration(video.durationSeconds)}
                 </div>
               )}
            </div>

            <Tabs defaultValue="metadata" className="w-full">
              <TabsList className="w-full justify-start border-b rounded-none h-auto p-0 bg-transparent mb-6 space-x-6">
                <TabsTrigger value="metadata" className="rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:shadow-none data-[state=active]:bg-transparent px-0 py-2">Metadata</TabsTrigger>
                <TabsTrigger value="embed" className="rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:shadow-none data-[state=active]:bg-transparent px-0 py-2">Embed & Links</TabsTrigger>
                <TabsTrigger value="analytics" className="rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:shadow-none data-[state=active]:bg-transparent px-0 py-2">Analytics</TabsTrigger>
              </TabsList>

              <TabsContent value="metadata" className="space-y-6">
                <div className="space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="title">Title</Label>
                    <Input
                      id="title"
                      value={title}
                      onChange={e => setTitle(e.target.value)}
                      className="text-base"
                      disabled={!canUpdate}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="description">Description</Label>
                    <Textarea
                      id="description"
                      value={description}
                      onChange={e => setDescription(e.target.value)}
                      className="min-h-[150px]"
                      disabled={!canUpdate}
                    />
                  </div>
                </div>
              </TabsContent>

              <TabsContent value="embed" className="space-y-6">
                <div className="space-y-2">
                  <Label>Embed Code</Label>
                  <div className="relative">
                    <Textarea
                      readOnly
                      value={embedReady ? embedCode : "Embed code will be available once the video is ready."}
                      className="font-mono text-xs bg-muted min-h-[100px]"
                    />
                    <Button
                      size="sm"
                      variant={copyStatus === "error" ? "destructive" : "secondary"}
                      className="absolute top-2 right-2 gap-1.5 h-7"
                      onClick={handleCopy}
                      disabled={!embedReady || copyStatus !== "idle"}
                    >
                      {copyStatus === "success" ? <Check className="h-3 w-3" /> : copyStatus === "error" ? <XCircle className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
                      {copyStatus === "success" ? "Copied!" : copyStatus === "error" ? "Failed" : "Copy"}
                    </Button>
                  </div>
                  <p className="text-xs text-muted-foreground mt-2">Place this iframe in your HTML to embed the player.</p>
                </div>
              </TabsContent>

              <TabsContent value="analytics" className="space-y-6">
                 <div className="grid grid-cols-2 gap-4">
                   <div className="border rounded-lg p-6 bg-card">
                     <div className="text-sm font-medium text-muted-foreground mb-1">Total Plays</div>
                     <div className="text-3xl font-bold">{formatNumber(video.plays)}</div>
                   </div>
                   <div className="border rounded-lg p-6 bg-card">
                     <div className="text-sm font-medium text-muted-foreground mb-1">Completion Rate</div>
                     <div className="text-3xl font-bold">{video.completionRate}%</div>
                   </div>
                 </div>
              </TabsContent>
            </Tabs>
          </div>

          <div className="space-y-6">
            <div className="border rounded-lg p-5 bg-card space-y-4 shadow-sm">
              <h3 className="font-semibold flex items-center gap-2">
                <Activity className="h-4 w-4" /> Visibility
              </h3>
              <div className="space-y-2">
                <Select value={video.visibility} onValueChange={handleVisibilityChange} disabled={!canUpdate}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="private">Private (Only Workspace)</SelectItem>
                    <SelectItem value="unlisted">Unlisted (Anyone with link)</SelectItem>
                    <SelectItem value="public">Public (Embeddable)</SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  {video.visibility === 'private' && "Only authenticated members of this workspace can view."}
                  {video.visibility === 'unlisted' && "Anyone with the direct link can view, but not indexed."}
                  {video.visibility === 'public' && "Fully accessible via embeds and direct links."}
                </p>
              </div>
            </div>

            <div className="border rounded-lg p-5 bg-card space-y-4 shadow-sm">
              <h3 className="font-semibold text-sm text-muted-foreground uppercase tracking-wider">Video Details</h3>
              <div className="space-y-3 text-sm">
                <div className="flex justify-between border-b pb-2">
                  <span className="text-muted-foreground">Duration</span>
                  <span className="font-mono">{formatDuration(video.durationSeconds)}</span>
                </div>
                <div className="flex justify-between border-b pb-2">
                  <span className="text-muted-foreground">Uploaded</span>
                  <span>{formatDate(video.createdAt)}</span>
                </div>
                <div className="flex justify-between pb-1">
                  <span className="text-muted-foreground">Status</span>
                  <span className="capitalize">{video.status}</span>
                </div>
              </div>
            </div>
          </div>

        </div>
      </div>

      <MoveVideoDialog
        video={video}
        open={moveVideoOpen}
        onOpenChange={setMoveVideoOpen}
      />
    </div>
  )
}