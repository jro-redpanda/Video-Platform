import { useState, useEffect, useRef } from "react"
import { useParams, Link } from "wouter"
import { useGetVideo, useUpdateVideo, getGetVideoQueryKey } from "@workspace/api-client-react"
import { useQueryClient } from "@tanstack/react-query"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { Skeleton } from "@/components/ui/skeleton"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { ArrowLeft, Play, Copy, ExternalLink, Activity } from "lucide-react"
import { formatDate, formatDuration, formatNumber } from "@/lib/utils"

export default function VideoDetail() {
  const { id } = useParams<{ id: string }>()
  const { data: video, isLoading } = useGetVideo(id)
  
  const queryClient = useQueryClient()
  const updateVideo = useUpdateVideo()
  
  // Local state for debounced saves
  const [title, setTitle] = useState("")
  const [description, setDescription] = useState("")
  const initializedId = useRef<string | null>(null)

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
        // Optimistic update
        queryClient.setQueryData(getGetVideoQueryKey(id), (old: any) => 
          old ? { ...old, ...updatedData } : old
        )
      }
    })
  }

  // Handle visibility change immediately
  const handleVisibilityChange = (value: string) => {
    handleUpdate({ visibility: value as any })
  }

  if (isLoading && !video) {
    return <div className="p-8 space-y-8"><Skeleton className="h-12 w-64" /><Skeleton className="h-96 w-full" /></div>
  }

  if (!video) {
    return <div className="p-8 text-center">Video not found.</div>
  }

  const embedCode = `<iframe src="https://player.example.com/v/${video.id}" width="100%" height="100%" frameborder="0" allowfullscreen></iframe>`

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
            <p className="text-xs text-muted-foreground font-mono mt-1">ID: {video.id} • Added {formatDate(video.createdAt)}</p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <Button variant="outline" className="gap-2">
            <ExternalLink className="h-4 w-4" /> Preview
          </Button>
          <Button className="gap-2" onClick={() => handleUpdate({ title, description })}>
            Save Changes
          </Button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-8">
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8 max-w-6xl mx-auto">
          
          <div className="lg:col-span-2 space-y-8">
            {/* Player Preview */}
            <div 
              className="aspect-video bg-black rounded-lg overflow-hidden relative shadow-lg ring-1 ring-border flex items-center justify-center group cursor-pointer"
              style={{ background: `linear-gradient(to bottom right, ${video.thumbnailColor || '#333'}, #111)` }}
            >
              <div className="w-16 h-16 rounded-full bg-white/20 backdrop-blur-md flex items-center justify-center text-white transition-transform group-hover:scale-110">
                <Play className="h-8 w-8 ml-1" />
              </div>
              <div className="absolute bottom-4 right-4 bg-black/60 backdrop-blur-md text-white text-xs font-mono px-2 py-1 rounded">
                {formatDuration(video.durationSeconds)}
              </div>
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
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="description">Description</Label>
                    <Textarea 
                      id="description" 
                      value={description} 
                      onChange={e => setDescription(e.target.value)}
                      className="min-h-[150px]"
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
                      value={embedCode}
                      className="font-mono text-xs bg-muted min-h-[100px]"
                    />
                    <Button 
                      size="sm" 
                      variant="secondary" 
                      className="absolute top-2 right-2 gap-1.5 h-7"
                      onClick={() => navigator.clipboard.writeText(embedCode)}
                    >
                      <Copy className="h-3 w-3" /> Copy
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
                <Select value={video.visibility} onValueChange={handleVisibilityChange}>
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
    </div>
  )
}
