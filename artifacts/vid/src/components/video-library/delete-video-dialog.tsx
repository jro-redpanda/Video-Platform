import { useEffect, useState } from "react"
import { useDeleteVideo } from "@workspace/api-client-react"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { useToast } from "@/components/ui/use-toast"
import type { Video } from "@workspace/api-client-react"

export function DeleteVideoDialog({
  video,
  open,
  onOpenChange,
  onSuccess
}: {
  video: Video | null,
  open: boolean,
  onOpenChange: (o: boolean) => void,
  onSuccess?: () => void
}) {
  const { mutate, isPending } = useDeleteVideo()
  const [error, setError] = useState<string | null>(null)
  const { toast } = useToast()

  useEffect(() => {
    if (open) setError(null)
  }, [open])

  const handleDelete = () => {
    if (!video) return
    setError(null)
    mutate({ videoId: video.id }, {
      onSuccess: () => {
        onSuccess?.()
        onOpenChange(false)
        toast({
          title: "Video deleted",
          description: `"${video.title}" has been successfully removed.`,
        })
      },
      onError: (err: any) => {
        if (err?.status === 503 || err?.response?.status === 503) {
          setError("This video is currently being processed and cannot be deleted right now. Please try again later.")
        } else {
          setError(err?.message || "Failed to delete video.")
        }
      }
    })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete Video</DialogTitle>
          <DialogDescription>
            Are you sure you want to delete <span className="font-semibold text-foreground">{video?.title}</span>? This action cannot be undone.
          </DialogDescription>
        </DialogHeader>
        {error && (
          <div className="text-sm p-3 bg-destructive/10 text-destructive rounded-md border border-destructive/20" data-testid="text-delete-error">
            {error}
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isPending}>Cancel</Button>
          <Button variant="destructive" onClick={handleDelete} disabled={isPending} data-testid="button-confirm-delete">
            {isPending ? "Deleting..." : "Delete Video"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
