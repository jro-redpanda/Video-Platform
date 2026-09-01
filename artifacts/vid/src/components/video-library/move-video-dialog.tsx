import { useState, useEffect } from "react"
import { useUpdateVideo, getListVideosQueryKey, getGetVideoQueryKey, getListFoldersQueryKey, getGetFolderQueryKey } from "@workspace/api-client-react"
import { useQueryClient } from "@tanstack/react-query"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { FolderBrowser } from "@/components/folders/folder-browser"
import { useToast } from "@/components/ui/use-toast"
import type { Video } from "@workspace/api-client-react"

export function MoveVideoDialog({ video, open, onOpenChange, onSuccess }: { video: Video | null, open: boolean, onOpenChange: (open: boolean) => void, onSuccess?: () => void }) {
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const updateVideo = useUpdateVideo()
  const queryClient = useQueryClient()
  const { toast } = useToast()

  useEffect(() => {
    if (open && video) setSelectedId(video.folderId)
  }, [open, video])

  const handleMove = () => {
    if (!video) return
    updateVideo.mutate({ videoId: video.id, data: { folderId: selectedId } }, {
      onSuccess: () => {
        toast({ title: "Video moved successfully" })
        queryClient.invalidateQueries({ queryKey: getListVideosQueryKey() })
        queryClient.invalidateQueries({ queryKey: getGetVideoQueryKey(video.id) })
        // Invalidate folders to update counts
        queryClient.invalidateQueries({ queryKey: getListFoldersQueryKey() })
        if (video.folderId && video.folderId !== "root") {
          queryClient.invalidateQueries({ queryKey: getGetFolderQueryKey(video.folderId) })
        }
        if (selectedId && selectedId !== "root") {
          queryClient.invalidateQueries({ queryKey: getGetFolderQueryKey(selectedId) })
        }
        onSuccess?.()
        onOpenChange(false)
      },
      onError: (err: any) => {
        toast({ title: "Failed to move video", variant: "destructive", description: err.message })
      }
    })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Move Video</DialogTitle>
        </DialogHeader>
        <div className="py-4">
          <FolderBrowser selectedId={selectedId} onSelect={setSelectedId} />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={handleMove} disabled={selectedId === video?.folderId || updateVideo.isPending}>
            {updateVideo.isPending ? "Moving..." : "Move"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
