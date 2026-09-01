import { useState } from "react"
import { Link } from "wouter"
import { useListVideos, useCreateVideo, getListVideosQueryKey } from "@workspace/api-client-react"
import { useQueryClient } from "@tanstack/react-query"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { Skeleton } from "@/components/ui/skeleton"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogTrigger } from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Search, Plus, Play, MoreHorizontal } from "lucide-react"
import { formatDate, formatDuration } from "@/lib/utils"

export default function Videos() {
  const [search, setSearch] = useState("")
  const { data: videos, isLoading } = useListVideos({ search: search || undefined })

  return (
    <div className="flex-1 p-8 overflow-y-auto">
      <div className="flex justify-between items-center mb-8">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Library</h1>
          <p className="text-muted-foreground mt-1">Manage and organize your video content.</p>
        </div>
        <UploadDialog />
      </div>

      <div className="flex items-center gap-4 mb-6">
        <div className="relative w-full max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input 
            placeholder="Search videos..." 
            className="pl-9"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
      </div>

      <div className="border rounded-lg bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-[400px]">Video</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Visibility</TableHead>
              <TableHead className="text-right">Duration</TableHead>
              <TableHead className="text-right">Plays</TableHead>
              <TableHead className="text-right">Added</TableHead>
              <TableHead className="w-[50px]"></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              Array.from({ length: 5 }).map((_, i) => (
                <TableRow key={i}>
                  <TableCell><Skeleton className="h-12 w-full" /></TableCell>
                  <TableCell><Skeleton className="h-6 w-16" /></TableCell>
                  <TableCell><Skeleton className="h-6 w-16" /></TableCell>
                  <TableCell><Skeleton className="h-6 w-12 ml-auto" /></TableCell>
                  <TableCell><Skeleton className="h-6 w-12 ml-auto" /></TableCell>
                  <TableCell><Skeleton className="h-6 w-24 ml-auto" /></TableCell>
                  <TableCell></TableCell>
                </TableRow>
              ))
            ) : videos?.length ? (
              videos.map((video) => (
                <TableRow key={video.id}>
                  <TableCell>
                    <div className="flex items-center gap-3">
                      <div 
                        className="w-16 h-10 rounded overflow-hidden flex items-center justify-center text-white flex-shrink-0"
                        style={{ backgroundColor: video.thumbnailColor || '#333' }}
                      >
                        <Play className="h-4 w-4 opacity-50" />
                      </div>
                      <div>
                        <div className="font-medium line-clamp-1">{video.title}</div>
                        {video.description && (
                          <div className="text-xs text-muted-foreground line-clamp-1">{video.description}</div>
                        )}
                      </div>
                    </div>
                  </TableCell>
                  <TableCell>
                    <Badge variant={
                      video.status === 'ready' ? 'success' : 
                      video.status === 'error' ? 'destructive' : 'warning'
                    }>
                      {video.status}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline" className="capitalize">
                      {video.visibility}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right font-mono text-sm">
                    {formatDuration(video.durationSeconds)}
                  </TableCell>
                  <TableCell className="text-right font-mono text-sm">
                    {video.plays}
                  </TableCell>
                  <TableCell className="text-right text-muted-foreground">
                    {formatDate(video.createdAt)}
                  </TableCell>
                  <TableCell>
                    <Link href={`/videos/${video.id}`} className="inline-flex items-center justify-center w-8 h-8 rounded-md hover:bg-muted text-muted-foreground hover:text-foreground transition-colors">
                      <MoreHorizontal className="h-4 w-4" />
                    </Link>
                  </TableCell>
                </TableRow>
              ))
            ) : (
              <TableRow>
                <TableCell colSpan={7} className="h-32 text-center text-muted-foreground">
                  No videos found. Upload one to get started.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  )
}

// MOCK: replaced at step 9
function UploadDialog() {
  const [open, setOpen] = useState(false)
  const [title, setTitle] = useState("")
  const [description, setDescription] = useState("")
  const queryClient = useQueryClient()
  
  const createVideo = useCreateVideo({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListVideosQueryKey() })
        setOpen(false)
        setTitle("")
        setDescription("")
      }
    }
  })

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!title) return
    createVideo.mutate({ data: { title, description } })
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button className="gap-2">
          <Plus className="h-4 w-4" /> Upload Video
        </Button>
      </DialogTrigger>
      <DialogContent>
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>Upload New Video</DialogTitle>
          </DialogHeader>
          <div className="py-6 space-y-4">
            <div className="space-y-2">
              <Label htmlFor="title">Video Title</Label>
              <Input 
                id="title" 
                value={title}
                onChange={e => setTitle(e.target.value)}
                placeholder="e.g. Q3 All Hands" 
                autoFocus
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="desc">Description (optional)</Label>
              <Textarea 
                id="desc" 
                value={description}
                onChange={e => setDescription(e.target.value)}
                placeholder="What is this video about?" 
              />
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button type="submit" disabled={!title || createVideo.isPending}>
              {createVideo.isPending ? "Creating..." : "Create Record"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
