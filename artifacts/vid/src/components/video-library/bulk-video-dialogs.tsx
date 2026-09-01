import { useState, useEffect } from "react"
import { useBulkUpdateVideos, useBulkDeleteVideos, BulkVideoActionResult, BulkVideoMoveInput, BulkVideoVisibilityInput, BulkVideoDeleteInput } from "@workspace/api-client-react"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { useToast } from "@/components/ui/use-toast"
import { FolderBrowser } from "@/components/folders/folder-browser"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { AlertCircle, CheckCircle2, Loader2 } from "lucide-react"
import type { Video } from "@workspace/api-client-react"

export type BulkResultContext = 
  | { action: 'move'; payload: BulkVideoMoveInput; result: BulkVideoActionResult }
  | { action: 'visibility'; payload: BulkVideoVisibilityInput; result: BulkVideoActionResult }
  | { action: 'delete'; payload: BulkVideoDeleteInput; result: BulkVideoActionResult };

interface BulkMoveDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  selectedIds: Set<string>;
  allVideos: Video[];
  onSuccess: (context: BulkResultContext) => void;
}

export function BulkMoveDialog({ open, onOpenChange, selectedIds, allVideos, onSuccess }: BulkMoveDialogProps) {
  const [selectedFolderId, setSelectedFolderId] = useState<string | null>(null)
  const { mutate, isPending } = useBulkUpdateVideos()
  const { toast } = useToast()

  // Reset folder selection when dialog opens
  useEffect(() => {
    if (open) setSelectedFolderId(null)
  }, [open])

  const handleMove = () => {
    if (selectedIds.size === 0) return
    const videoIds = Array.from(selectedIds)
    const payload: BulkVideoMoveInput = { operation: 'move', videoIds, folderId: selectedFolderId }
    mutate({ data: payload }, {
      onSuccess: (result) => {
        onSuccess({ action: 'move', payload, result })
        onOpenChange(false)
      },
      onError: (error: any) => {
        toast({ title: "Move failed", description: error.message || "An error occurred", variant: "destructive" })
      }
    })
  }

  return (
    <Dialog open={open} onOpenChange={(val) => !isPending && onOpenChange(val)}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] flex flex-col overflow-hidden">
        <DialogHeader className="shrink-0">
          <DialogTitle>Move {selectedIds.size} videos</DialogTitle>
          <DialogDescription>Select a destination folder for the selected videos.</DialogDescription>
        </DialogHeader>
        <div className="min-h-0 overflow-y-auto py-4">
          <FolderBrowser selectedId={selectedFolderId} onSelect={setSelectedFolderId} />
        </div>
        <DialogFooter className="shrink-0">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isPending}>Cancel</Button>
          <Button onClick={handleMove} disabled={isPending}>
            {isPending ? "Moving..." : "Move Videos"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

interface BulkVisibilityDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  selectedIds: Set<string>;
  onSuccess: (context: BulkResultContext) => void;
}

export function BulkVisibilityDialog({ open, onOpenChange, selectedIds, onSuccess }: BulkVisibilityDialogProps) {
  const [visibility, setVisibility] = useState<'private' | 'unlisted' | 'public'>('private')
  const { mutate, isPending } = useBulkUpdateVideos()
  const { toast } = useToast()

  useEffect(() => {
    if (open) setVisibility('private')
  }, [open])

  const handleUpdate = () => {
    if (selectedIds.size === 0) return
    const videoIds = Array.from(selectedIds)
    const payload: BulkVideoVisibilityInput = { operation: 'visibility', videoIds, visibility }
    mutate({ data: payload }, {
      onSuccess: (result) => {
        onSuccess({ action: 'visibility', payload, result })
        onOpenChange(false)
      },
      onError: (error: any) => {
        toast({ title: "Visibility update failed", description: error.message || "An error occurred", variant: "destructive" })
      }
    })
  }

  return (
    <Dialog open={open} onOpenChange={(val) => !isPending && onOpenChange(val)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Change visibility for {selectedIds.size} videos</DialogTitle>
        </DialogHeader>
        <div className="py-4 space-y-4">
          <label className="text-sm font-medium">New Visibility</label>
          <Select value={visibility} onValueChange={(val: 'private' | 'unlisted' | 'public') => setVisibility(val)}>
            <SelectTrigger>
              <SelectValue placeholder="Select visibility" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="private">Private</SelectItem>
              <SelectItem value="unlisted">Unlisted</SelectItem>
              <SelectItem value="public">Public</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isPending}>Cancel</Button>
          <Button onClick={handleUpdate} disabled={isPending}>
            {isPending ? "Updating..." : "Update Visibility"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

interface BulkDeleteDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  selectedIds: Set<string>;
  onSuccess: (context: BulkResultContext) => void;
}

export function BulkDeleteDialog({ open, onOpenChange, selectedIds, onSuccess }: BulkDeleteDialogProps) {
  const { mutate, isPending } = useBulkDeleteVideos()
  const { toast } = useToast()

  const handleDelete = () => {
    if (selectedIds.size === 0) return
    const videoIds = Array.from(selectedIds)
    const payload: BulkVideoDeleteInput = { videoIds }
    mutate({ data: payload }, {
      onSuccess: (result) => {
        onSuccess({ action: 'delete', payload, result })
        onOpenChange(false)
      },
      onError: (error: any) => {
        toast({ title: "Delete failed", description: error.message || "An error occurred", variant: "destructive" })
      }
    })
  }

  return (
    <Dialog open={open} onOpenChange={(val) => !isPending && onOpenChange(val)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete {selectedIds.size} videos</DialogTitle>
          <DialogDescription>
            Are you sure you want to delete these {selectedIds.size} videos? This action cannot be undone.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isPending}>Cancel</Button>
          <Button variant="destructive" onClick={handleDelete} disabled={isPending} data-testid="button-confirm-bulk-delete">
            {isPending ? "Deleting..." : "Delete Videos"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

interface BulkResultDialogProps {
  resultContext: BulkResultContext | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  allVideos: Video[];
  onRetrySuccess: (context: BulkResultContext) => void;
}

export function BulkResultDialog({ resultContext, open, onOpenChange, allVideos, onRetrySuccess }: BulkResultDialogProps) {
  const { mutate: mutateUpdate, isPending: isUpdating } = useBulkUpdateVideos()
  const { mutate: mutateDelete, isPending: isDeleting } = useBulkDeleteVideos()
  const { toast } = useToast()
  
  if (!resultContext) return null;
  const { action, result, payload } = resultContext;

  const isPending = isUpdating || isDeleting;
  const total = result.succeeded.length + result.failed.length;
  const hasFailures = result.failed.length > 0;
  
  const getActionText = (pastTense: boolean) => {
    switch (action) {
      case 'move': return pastTense ? 'moved' : 'move';
      case 'visibility': return pastTense ? 'updated' : 'update';
      case 'delete': return pastTense ? 'deleted' : 'delete';
    }
  }

  const handleRetry = () => {
    const failedIds = result.failed.map(f => f.videoId);
    
    if (action === 'move') {
      const retryPayload: BulkVideoMoveInput = { ...(payload as BulkVideoMoveInput), videoIds: failedIds };
      mutateUpdate({ data: retryPayload }, {
        onSuccess: (newResult) => {
          onRetrySuccess({ action: 'move', payload: retryPayload, result: newResult })
        },
        onError: (error: any) => {
          toast({ title: "Retry failed", description: error.message || "An error occurred", variant: "destructive" })
        }
      })
    } else if (action === 'visibility') {
      const retryPayload: BulkVideoVisibilityInput = { ...(payload as BulkVideoVisibilityInput), videoIds: failedIds };
      mutateUpdate({ data: retryPayload }, {
        onSuccess: (newResult) => {
          onRetrySuccess({ action: 'visibility', payload: retryPayload, result: newResult })
        },
        onError: (error: any) => {
          toast({ title: "Retry failed", description: error.message || "An error occurred", variant: "destructive" })
        }
      })
    } else if (action === 'delete') {
      const retryPayload: BulkVideoDeleteInput = { videoIds: failedIds };
      mutateDelete({ data: retryPayload }, {
        onSuccess: (newResult) => {
          onRetrySuccess({ action: 'delete', payload: retryPayload, result: newResult })
        },
        onError: (error: any) => {
          toast({ title: "Retry failed", description: error.message || "An error occurred", variant: "destructive" })
        }
      })
    }
  }

  return (
    <Dialog open={open} onOpenChange={(val) => !isPending && onOpenChange(val)}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {hasFailures ? <AlertCircle className="h-5 w-5 text-destructive" /> : <CheckCircle2 className="h-5 w-5 text-primary" />}
            {hasFailures ? `Partial Success` : `Success`}
          </DialogTitle>
          <DialogDescription>
            {result.succeeded.length} of {total} videos successfully {getActionText(true)}.
          </DialogDescription>
        </DialogHeader>
        
        {hasFailures && (
          <div className="max-h-[300px] overflow-y-auto space-y-3 mt-4 border rounded-md p-3 bg-muted/30">
            {result.failed.map((failure, i) => {
              const video = allVideos.find(v => v.id === failure.videoId);
              return (
                <div key={`${failure.videoId}-${i}`} className="text-sm">
                  <div className="font-semibold text-foreground truncate">{video?.title || 'Unknown Video'}</div>
                  <div className="text-destructive text-xs mt-0.5">{failure.error}</div>
                </div>
              )
            })}
          </div>
        )}

        <DialogFooter className="mt-4">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isPending}>Close</Button>
          {hasFailures && (
            <Button onClick={handleRetry} disabled={isPending}>
              {isPending ? <><Loader2 className="h-4 w-4 mr-2 animate-spin" /> Retrying...</> : "Retry Failed"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

