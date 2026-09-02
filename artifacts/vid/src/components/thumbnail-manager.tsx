import { useState, useRef } from "react"
import { Button } from "@/components/ui/button"
import {
  useCreateThumbnailUploadIntent,
  useFinalizeThumbnail,
  useDeleteVideoThumbnail,
  getGetVideoQueryKey,
  getGetAuthenticatedVideoPlaybackQueryKey,
  ThumbnailUploadIntentInputContentType
} from "@workspace/api-client-react"
import { useQueryClient } from "@tanstack/react-query"
import { useToast } from "@/components/ui/use-toast"
import { Image as ImageIcon, Trash2, UploadCloud, X, Loader2 } from "lucide-react"

export function ThumbnailManager({ video, canUpdate }: { video: any, canUpdate: boolean }) {
  const [selectedFile, setSelectedFile] = useState<File | null>(null)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [isUploading, setIsUploading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const queryClient = useQueryClient()
  const { toast } = useToast()

  const createIntent = useCreateThumbnailUploadIntent()
  const finalizeUpload = useFinalizeThumbnail()
  const deleteThumbnail = useDeleteVideoThumbnail()

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return

    setError(null)

    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
      setError("Only JPEG, PNG, and WebP images are supported.")
      return
    }

    if (file.size < 1) {
      setError("File is empty.")
      return
    }

    if (file.size > 10 * 1024 * 1024) {
      setError("File must be less than 10 MiB.")
      return
    }

    setSelectedFile(file)
    setPreviewUrl(URL.createObjectURL(file))
  }

  const handleCancel = () => {
    if (previewUrl) URL.revokeObjectURL(previewUrl)
    setSelectedFile(null)
    setPreviewUrl(null)
    setError(null)
    if (fileInputRef.current) fileInputRef.current.value = ""
  }

  const invalidateCaches = () => {
    queryClient.invalidateQueries({ queryKey: getGetVideoQueryKey(video.id) })
    queryClient.invalidateQueries({ queryKey: getGetAuthenticatedVideoPlaybackQueryKey(video.id) })
    queryClient.invalidateQueries({ queryKey: ['/api/videos'] })
  }

  const handleSave = async () => {
    if (!selectedFile) return
    setIsUploading(true)
    setError(null)

    try {
      const intentRes = await createIntent.mutateAsync({
        videoId: video.id,
        data: {
          contentType: selectedFile.type as ThumbnailUploadIntentInputContentType,
          sizeBytes: selectedFile.size
        }
      })

      const uploadRes = await fetch(intentRes.uploadUrl, {
        method: 'PUT',
        headers: intentRes.requiredHeaders,
        body: selectedFile,
        credentials: 'omit'
      })

      if (!uploadRes.ok) {
        throw new Error("Failed to upload file to storage")
      }

      const finalRes = await finalizeUpload.mutateAsync({
        videoId: video.id,
        data: { intentId: intentRes.intentId }
      })

      queryClient.setQueryData(getGetVideoQueryKey(video.id), (old: any) =>
        old ? { ...old, thumbnailUrl: finalRes.thumbnailUrl } : old
      )

      queryClient.setQueryData(getGetAuthenticatedVideoPlaybackQueryKey(video.id), (old: any) =>
        old ? { ...old, posterUrl: finalRes.thumbnailUrl } : old
      )

      toast({
        title: "Thumbnail updated",
        description: "Your video thumbnail has been updated successfully.",
      })

      handleCancel()
      invalidateCaches()
    } catch (err: any) {
      setError(err.message || "An error occurred while uploading.")
    } finally {
      setIsUploading(false)
    }
  }

  const handleDelete = async () => {
    if (!window.confirm("Are you sure you want to remove the custom thumbnail?")) return
    setIsUploading(true)
    setError(null)

    try {
      await deleteThumbnail.mutateAsync({ videoId: video.id })

      queryClient.setQueryData(getGetVideoQueryKey(video.id), (old: any) =>
        old ? { ...old, thumbnailUrl: null } : old
      )

      queryClient.setQueryData(getGetAuthenticatedVideoPlaybackQueryKey(video.id), (old: any) =>
        old ? { ...old, posterUrl: null } : old
      )

      toast({
        title: "Thumbnail removed",
        description: "The custom thumbnail has been removed.",
      })
      invalidateCaches()
    } catch (err: any) {
      setError(err.message || "Failed to delete thumbnail.")
    } finally {
      setIsUploading(false)
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-medium tracking-tight">Custom Thumbnail</h3>
          <p className="text-sm text-muted-foreground">Upload a custom image to represent this video.</p>
        </div>
        {canUpdate && video.thumbnailUrl && !selectedFile && (
          <Button variant="destructive" size="sm" onClick={handleDelete} disabled={isUploading} data-testid="button-delete-thumbnail">
            <Trash2 className="h-4 w-4 mr-2" /> Remove Custom
          </Button>
        )}
      </div>

      {error && (
        <div className="bg-destructive/10 text-destructive text-sm p-3 rounded-md border border-destructive/20" data-testid="text-error-thumbnail">
          {error}
        </div>
      )}

      <div className="grid gap-6 md:grid-cols-2">
        <div className="space-y-4">
          <div
            className={`aspect-video w-full border-2 ${selectedFile ? 'border-primary' : 'border-border'} rounded-lg overflow-hidden relative flex flex-col items-center justify-center bg-muted transition-colors`}
            style={!selectedFile && !video.thumbnailUrl ? { backgroundColor: video.thumbnailColor || '#333' } : {}}
          >
            {previewUrl ? (
              <img src={previewUrl} alt="Thumbnail preview" className="w-full h-full object-cover" data-testid="img-thumbnail-preview" />
            ) : video.thumbnailUrl ? (
              <img src={video.thumbnailUrl} alt={`Thumbnail for ${video.title}`} className="w-full h-full object-cover" data-testid="img-thumbnail-current" />
            ) : (
              <div className="absolute inset-0 flex items-center justify-center">
                 <ImageIcon className="h-12 w-12 text-white/20" />
              </div>
            )}

            {isUploading && (
              <div className="absolute inset-0 bg-background/80 backdrop-blur-sm flex flex-col items-center justify-center gap-3">
                <Loader2 className="h-8 w-8 animate-spin text-primary" />
                <span className="text-sm font-medium">Uploading...</span>
              </div>
            )}
          </div>

          {selectedFile && (
            <div className="flex items-center justify-between text-sm bg-muted p-3 rounded-md border">
              <span className="truncate max-w-[250px] font-medium" title={selectedFile.name}>{selectedFile.name}</span>
              <span className="text-muted-foreground font-mono">{(selectedFile.size / 1024 / 1024).toFixed(2)} MiB</span>
            </div>
          )}
        </div>

        {canUpdate && (
          <div className="flex flex-col justify-center space-y-4">
            {!selectedFile ? (
              <div className="space-y-4">
                 <div className="text-sm text-muted-foreground space-y-2 border-l-2 border-muted pl-4 py-1">
                   <p><strong>Recommended resolution:</strong> 1280x720</p>
                   <p><strong>Supported formats:</strong> JPEG, PNG, WebP</p>
                   <p><strong>Size limit:</strong> 10 MiB</p>
                 </div>
                 <div>
                   <input
                     type="file"
                     accept="image/jpeg,image/png,image/webp"
                     className="hidden"
                     ref={fileInputRef}
                     onChange={handleFileChange}
                     data-testid="input-thumbnail-file"
                   />
                   <Button onClick={() => fileInputRef.current?.click()} variant="secondary" className="w-full shadow-sm" disabled={isUploading} data-testid="button-select-thumbnail">
                     <UploadCloud className="h-4 w-4 mr-2" /> Select Image
                   </Button>
                 </div>
              </div>
            ) : (
              <div className="space-y-3 p-4 bg-muted/50 rounded-lg border">
                <p className="text-sm font-medium mb-2">Ready to upload</p>
                <Button onClick={handleSave} className="w-full" disabled={isUploading} data-testid="button-save-thumbnail">
                  {isUploading ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <UploadCloud className="h-4 w-4 mr-2" />}
                  {isUploading ? 'Uploading...' : 'Upload & Save Thumbnail'}
                </Button>
                <Button onClick={handleCancel} variant="ghost" className="w-full" disabled={isUploading} data-testid="button-cancel-thumbnail">
                  Cancel
                </Button>
              </div>
            )}
          </div>
        )}

        {!canUpdate && (
          <div className="flex flex-col justify-center text-sm text-muted-foreground">
            You do not have permission to update this video's thumbnail.
          </div>
        )}
      </div>
    </div>
  )
}
